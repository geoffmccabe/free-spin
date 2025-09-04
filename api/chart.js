import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// UTC helpers
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
function isoUTC(d){ return d.toISOString(); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Which mint is tied to the link?
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!effectiveMint;

    // Date window (UTC)
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay   = today;

    // Fetch rows within the window (inclusive start, exclusive end+1)
    const gteISO = isoUTC(startDay);
    const ltISO  = isoUTC(addDays(endDay, 1));

    let rows = [];

    if (perToken) {
      // --- Per-token view (NO mixing) ---
      // 1) All rows where the mint matches (historic + new)
      const qMint = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('contract_address', effectiveMint)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (!qMint.error && qMint.data) rows = rows.concat(qMint.data);

      // 2) Legacy rows (older days) on THIS server where contract_address IS NULL
      //    These were pre-mint stamping; per your direction we attribute them to Harold only.
      const qLegacy = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .is('contract_address', null)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (!qLegacy.error && qLegacy.data) rows = rows.concat(qLegacy.data);

      // 3) Also include rows where contract_address matches but server_id is NULL (very old)
      const qVeryOld = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .is('server_id', null)
        .eq('contract_address', effectiveMint)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (!qVeryOld.error && qVeryOld.data) rows = rows.concat(qVeryOld.data);

    } else {
      // --- All tokens for this server ---
      // New rows stamped with this server_id
      const a = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .gte('created_at', gteISO)
        .lt('created_at', ltISO);
      if (!a.error && a.data) rows = rows.concat(a.data);

      // Legacy rows (no server_id) only for mints that belong to this server
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const serverMints = (st || []).map(r => String(r.contract_address || '').trim()).filter(Boolean);

      if (serverMints.length) {
        const b = await supabase
          .from('daily_spins')
          .select('created_at,reward,contract_address')
          .is('server_id', null)
          .in('contract_address', serverMints)
          .gte('created_at', gteISO)
          .lt('created_at', ltISO);
        if (!b.error && b.data) rows = rows.concat(b.data);
      }

      // NOTE: We intentionally DO NOT include rows where both server_id and contract_address are NULL
      // in "All tokens" (can’t safely attribute to this server). Those only appear in per-token view.
    }

    // Range=all -> extend startDay back to first record we fetched
    if (rows.length && range === 'all') {
      const minTs = rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +today);
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // Bucket by UTC day
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

    // Only show Avg Payout on per-token view so we never mix Harold & Fatcoin
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
