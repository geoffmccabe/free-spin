import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- UTC helpers ---------- */
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
function isoUTC(d){ return d.toISOString(); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Get the mint tied to this link (fallback if caller doesn't pass one)
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const mint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!mint;

    // ----- Window (UTC) -----
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay   = today;

    // Fetch slightly wider than we display (to avoid timezone edge loss), then bucket strictly.
    const fetchStart = addDays(startDay, -2);
    const fetchEnd   = addDays(endDay,   1); // exclusive
    const gteISO = isoUTC(fetchStart);
    const ltISO  = isoUTC(fetchEnd);

    let rows = [];

    if (perToken) {
      // **Per-token view:** use only rows where the mint matches (no legacy fallbacks).
      const q = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('contract_address', mint)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (q.error) return res.status(400).json({ error: q.error.message });
      rows = q.data || [];
    } else {
      // **All-tokens (server) view:** spins only (no payouts), combine stamped + server legacy mints.
      const a = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (a.error) return res.status(400).json({ error: a.error.message });
      rows = (a.data || []);

      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const mints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

      if (mints.length) {
        const b = await supabase
          .from('daily_spins')
          .select('created_at,reward,contract_address')
          .is('server_id', null)
          .in('contract_address', mints)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (b.error) return res.status(400).json({ error: b.error.message });
        rows = rows.concat(b.data || []);
      }
    }

    // Range = all → extend start to earliest fetched record
    if (rows.length && range === 'all') {
      const minTs = rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +today);
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // Bucket by UTC day strictly inside [startDay..endDay]
    const startKey = ymdUTC(startDay), endKey = ymdUTC(endDay);
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= endKey; d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (key >= startKey && key <= endKey) {
        buckets[key].count += 1;
        buckets[key].sum   += Number(r.reward || 0);
      }
    }

    const labels = Object.keys(buckets).sort();
    const spins  = labels.map(k => buckets[k].count);

    const datasets = [
      { label: 'Spins', yAxisID: 'y', data: spins, borderWidth: 2, pointRadius: 0, tension: 0.25 }
    ];

    // Per-token view: show **Total Payout** (never mix coins)
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
