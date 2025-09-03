import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- UTC helpers ---
function ymdUTC(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function addDaysUTC(d,n){ const x=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate()+n); return x; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, contract_address, range = 'past30' } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Validate token exists
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // Allowed mints for this server
    const { data: st, error: stErr } = await supabase
      .from('server_tokens').select('contract_address').eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const allowed = new Set((st || []).map(r => String(r.contract_address || '').trim()).filter(Boolean));
    if (!allowed.size) return res.status(200).json({ chartData: { labels: [], datasets: [] }, options: {} });

    let mints;
    if (contract_address) {
      if (!allowed.has(contract_address)) return res.status(400).json({ error: 'Invalid token for this server' });
      mints = [contract_address];
    } else {
      mints = Array.from(allowed);
    }

    // Build UTC day window (with +/− one-day buffer to catch late writes)
    const now = new Date();
    const endDay = addDaysUTC(now, 0); // include today
    const startDay = (range === 'all') ? null : addDaysUTC(endDay, -29);
    const startIso = startDay ? addDaysUTC(startDay, -1).toISOString() : undefined;
    const endIso   = addDaysUTC(endDay, 1).toISOString();

    // Query daily_spins ONLY
    let q = supabase.from('daily_spins')
      .select('created_at,reward,contract_address')
      .lte('created_at', endIso);
    if (startIso) q = q.gte('created_at', startIso);
    if (mints?.length) q = q.in('contract_address', mints);

    const { data: rowsRaw, error: rowsErr } = await q;
    if (rowsErr) return res.status(400).json({ error: rowsErr.message });
    const rows = (rowsRaw || []).map(r => ({
      created_at: r.created_at,
      reward: Number(r.reward || 0),
      contract_address: r.contract_address
    }));

    // For "all", find earliest day with data; else use past30
    const bucketStart = (range === 'all')
      ? (rows.length ? addDaysUTC(new Date(rows.reduce((min, r)=> Math.min(min, +new Date(r.created_at)), +new Date())).toISOString(), 0)
                     : addDaysUTC(endDay, -29))
      : startDay;

    // Build UTC buckets day-by-day
    const buckets = {};
    for (let d = bucketStart; ymdUTC(d) <= ymdUTC(endDay); d = addDaysUTC(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (!buckets[key]) buckets[key] = { count: 0, sum: 0 };
      buckets[key].count += 1;
      buckets[key].sum   += Number(r.reward || 0);
    }

    const labels = Object.keys(buckets).sort();
    const spinsSeries = labels.map(k => buckets[k].count);
    const avgSeries   = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);

    return res.status(200).json({
      chartData: {
        labels,
        datasets: [
          { label: 'Spins',      yAxisID: 'y',  data: spinsSeries, borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Avg Payout', yAxisID: 'y1', data: avgSeries,   borderWidth: 2, pointRadius: 0, tension: 0.2 }
        ]
      },
      options: {}
    });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
