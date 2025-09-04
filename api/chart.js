import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- UTC helpers ----
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
function isoUTC(d){ return d.toISOString(); }

// build a stable de-dup key even if table lacks an id column
function rowKey(r){
  // prefer explicit id if it exists on the row; otherwise synthesize from fields
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

    // Learn the mint tied to this link
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!effectiveMint;

    // ----- window (UTC) -----
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay   = today;

    const gteISO = isoUTC(startDay);
    const ltISO  = isoUTC(addDays(endDay, 1));

    // ----- collect rows -----
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
      // (2) Legacy rows on THIS server where mint is NULL (pre-mint-stamping on your server)
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
      // (4) **Unattributed legacy**: BOTH server_id and mint are NULL (this is what was missing Aug 14–29)
      //     You confirmed it’s acceptable to treat these as Harold-era legacy rows.
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
      // ---- All tokens for this server (no payout mixing on chart — we draw Spins only in this view) ----
      // New rows stamped with server_id
      {
        const q = await supabase
          .from('daily_spins')
          .select('id,created_at,reward,discord_id,server_id,contract_address')
          .eq('server_id', server_id)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!q.error) add(q.data);
      }
      // Legacy rows (server_id NULL) for this server's mints
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
      // NOTE: we intentionally do NOT include rows where both fields are NULL in the all-server view
      // because they cannot be safely attributed to this server.
    }

    // ----- de-duplicate (rows may overlap across the 4 legacy queries) -----
    const seen = new Set();
    rows = rows.filter(r => {
      const k = rowKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // ----- extend to "all time" if requested -----
    if (rows.length && range === 'all') {
      const minTs = rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +today);
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // ----- bucket by UTC day -----
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

    // Avg Payout only for per-token view (prevents Harold/Fatcoin mixing)
    if (perToken) {
      const avg = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);
      datasets.push({ label: 'Avg Payout', yAxisID: 'y1', data: avg, borderWidth: 2, pointRadius: 0, tension: 0.25 });
    }

    return res.status(200).json({ chartData: { labels, datasets }, options: {} });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
