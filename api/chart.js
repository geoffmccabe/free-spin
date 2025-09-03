import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- UTC helpers
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Verify token exists & get the mint tied to the link
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // If caller passes a mint, use it; otherwise use the mint from the link
    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!effectiveMint;                 // true = chart one mint (Spins + Avg Payout)
    const chartAllTokens = !perToken;                 // false = server-wide (Spins only)

    // Window
    const now = new Date();
    const todayUTC = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fetchStart = addDays(todayUTC, -90);        // wide fetch for safety
    let startDay = addDays(todayUTC, -29);            // UI default: past 30 days
    let endDay   = todayUTC;

    // All server mints (enabled/disabled) for legacy merge
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const serverMints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

    // ---- Fetch rows
    let rows = [];

    if (perToken) {
      // A) rows stamped with server_id AND this mint
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .eq('contract_address', effectiveMint)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows (server_id is null) for this mint
      const b = await supabase.from('daily_spins')
        .select('created_at,reward')
        .is('server_id', null)
        .eq('contract_address', effectiveMint)
        .gte('created_at', fetchStart.toISOString());
      if (!b.error && b.data) rows = rows.concat(b.data);
    } else {
      // A) rows stamped with server_id (any mint)
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows for any mint belonging to this server
      if (serverMints.length) {
        const b = await supabase.from('daily_spins')
          .select('created_at,reward,contract_address')
          .is('server_id', null)
          .gte('created_at', fetchStart.toISOString())
          .in('contract_address', serverMints);
        if (!b.error && b.data) rows = rows.concat(b.data);
      }
    }

    if (range === 'all') {
      const minTs = rows.length ? rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +todayUTC) : +todayUTC;
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // ---- Bucket by UTC day
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= ymdUTC(endDay); d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (key >= ymdUTC(startDay) && key <= ymdUTC(endDay)) {
        (buckets[key] ||= { count: 0, sum: 0 });
        buckets[key].count += 1;
        buckets[key].sum   += Number(r.reward || 0);
      }
    }

    const labels = Object.keys(buckets).sort();
    const spins  = labels.map(k => buckets[k].count);

    const datasets = [
      { label:'Spins', yAxisID:'y', data: spins, borderWidth:2, pointRadius:0, tension:0.2 }
    ];

    // Only add Avg Payout when charting a single token (HAROLD/FATCOIN)
    if (perToken) {
      const avg = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);
      datasets.push({ label:'Avg Payout', yAxisID:'y1', data: avg, borderWidth:2, pointRadius:0, tension:0.2 });
    }

    return res.status(200).json({
      chartData: { labels, datasets },
      options: {} // keep client options
    });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
