import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- UTC helpers ---------- */
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
function isoUTC(d){ return d.toISOString(); }

/* make a dedup key even if table lacks a numeric id */
function rowKey(r){
  if (r.id !== undefined && r.id !== null) return `id:${r.id}`;
  return [
    r.discord_id ?? '',
    r.contract_address ?? '',
    r.server_id ?? '',
    r.created_at ?? '',
    Number(r.reward ?? 0)
  ].join('|');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Resolve link + default mint
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!effectiveMint;

    // ----- Window (UTC) -----
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay   = today;

    // To be robust for “today” and legacy timezone quirks, fetch a slightly wider window,
    // then bucket strictly into [startDay .. endDay].
    const fetchStart = addDays(startDay, -2);
    const fetchEnd   = addDays(endDay,   1); // exclusive
    const gteISO = isoUTC(fetchStart);
    const ltISO  = isoUTC(fetchEnd);

    // ----- Collect rows -----
    let rows = [];
    const add = (batch)=>{ if (batch && Array.isArray(batch)) rows = rows.concat(batch); };

    if (perToken) {
      // (1) Mint-tagged rows (any server_id)
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .eq('contract_address', effectiveMint)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
      // (2) Legacy on THIS server where mint is NULL (your early Harold days)
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .eq('server_id', server_id)
          .is('contract_address', null)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
      // (3) Very old rows: mint present but server_id NULL
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .is('server_id', null)
          .eq('contract_address', effectiveMint)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
      // (4) Unattributed legacy: BOTH NULL (you asked to treat these as Harold-era legacy)
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .is('server_id', null)
          .is('contract_address', null)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
    } else {
      // ---- Server-wide view (no payout line here; spins only) ----
      // Stamped with server_id
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .eq('server_id', server_id)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
      // Legacy (server_id NULL) for this server's mints
      {
        const { data: st, error: stErr } = await supabase
          .from('server_tokens')
          .select('contract_address')
          .eq('server_id', server_id);
        if (stErr) return res.status(400).json({ error: stErr.message });
        const mints = (st || []).map(r => String(r.contract_address || '').trim()).filter(Boolean);
        if (mints.length) {
          const q = await supabase
            .from('daily_spins')
            .select('id,created_at,reward,discord_id,server_id,contract_address')
            .is('server_id', null)
            .in('contract_address', mints)
            .gte('created_at', gteISO)
            .lt('created_at', ltISO);
          if (!q.error) add(q.data);
        }
      }
      // We still do NOT include both-NULL rows here (can’t safely attribute to this server).
    }

    // ----- De-duplicate across legacy overlaps -----
    const seen = new Set();
    rows = rows.filter(r => {
      const k = rowKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // ----- If "all time" chosen, extend start to earliest fetched record -----
    if (rows.length && range === 'all') {
      const minTs = rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +today);
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // ----- Bucket strictly by UTC day inside [startDay..endDay] -----
    const startKey = ymdUTC(startDay), endKey = ymdUTC(endDay);
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= endKey; d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (key >= startKey && key <= endKey) {
        (buckets[key] ||= { count: 0, sum: 0 });
        buckets[key].count += 1;
        buckets[key].sum   += Number(r.reward || 0);
      }
    }

    const labels = Object.keys(buckets).sort();
    const spins  = labels.map(k => buckets[k].count);

    const datasets = [
      { label: 'Spins', yAxisID: 'y', data: spins, borderWidth: 2, pointRadius: 0, tension: 0.25 }
    ];

    // *** Show TOTAL Payout for single-token view (never mix coins) ***
    if (perToken) {
      const totals = labels.map(k => +(buckets[k].sum).toFixed(2));
      datasets.push({ label: 'Total Payout', yAxisID: 'y1', data: totals, borderWidth: 2, pointRadius: 0, tension: 0.25 });
    }

    return res.status(200).json({ chartData: { labels, datasets }, options: {} });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
