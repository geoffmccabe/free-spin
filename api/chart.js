import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Format yyyy-mm-dd (UTC)
function toYMD(d) {
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth()+1).padStart(2,'0');
  const da = String(d.getUTCDate()).padStart(2,'0');
  return `${yr}-${mo}-${da}`;
}
function addDays(d, n){ const x = new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  try{
    const { token, server_id, contract_address, range } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error:'token and server_id required' });

    // Validate token to discord_id
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    // Verify contract belongs to the server (if provided)
    let mintList = [];
    if (contract_address) {
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      mintList = (st||[]).map(r=>r.contract_address);
      if (!mintList.includes(contract_address)) {
        return res.status(400).json({ error:'Invalid token for this server' });
      }
    }

    // Time window
    const today = new Date(); // UTC "today"
    let start;
    if (range === 'all') {
      // earliest spin
      const { data: first, error: firstErr } = await supabase
        .from('daily_spins').select('created_at').order('created_at', { ascending: true }).limit(1);
      start = first && first[0] ? new Date(first[0].created_at) : addDays(today, -30);
    } else {
      start = addDays(today, -29); // past30 includes today -> 30 buckets
    }
    // Normalize start to 00:00:00 UTC
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));

    // Get spins for this contract & range
    let q = supabase.from('daily_spins')
      .select('created_at,reward,contract_address')
      .gte('created_at', start.toISOString());
    if (contract_address) q = q.eq('contract_address', contract_address);
    const { data: spins, error: spinsErr } = await q;
    if (spinsErr) return res.status(400).json({ error: spinsErr.message });

    // Bucket by day (UTC)
    const buckets = {};
    for (let d = new Date(start); toYMD(d) <= toYMD(today); d = addDays(d, 1)) {
      buckets[toYMD(d)] = { count: 0, sum: 0 };
    }
    for (const s of (spins||[])) {
      const dt = new Date(s.created_at);
      const key = toYMD(dt);
      if (!buckets[key]) buckets[key] = { count: 0, sum: 0 };
      buckets[key].count += 1;
      buckets[key].sum += Number(s.reward || 0);
    }

    const labels = Object.keys(buckets).sort();
    const spinsSeries = labels.map(k => buckets[k].count);
    const avgSeries   = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);

    const chartData = {
      labels,
      datasets: [
        {
          label: 'Spins',
          yAxisID: 'y',
          data: spinsSeries,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        },
        {
          label: 'Avg Payout',
          yAxisID: 'y1',
          data: avgSeries,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        }
      ]
    };

    return res.status(200).json({ chartData, options: {} });
  }catch(e){
    console.error('chart error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
