import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// yyyy-mm-dd
function ymd(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function addDays(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }

/**
 * Local bucketing: convert UTC timestamp -> local day key using tzOffsetMin
 * e.g. Costa Rica: tzOffsetMin = -360
 * We compute localKey = ymd( new Date(utcMs + tzOffsetMin*60*1000) )
 */
function localKeyFromUTC(utcDate, tzOffsetMin){
  return ymd(new Date(utcDate.getTime() + tzOffsetMin*60*1000));
}

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  try{
    const { token, server_id, contract_address, range, tzOffsetMin } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error:'token and server_id required' });

    const tz = Number.isFinite(+tzOffsetMin) ? +tzOffsetMin : -360; // default CR

    // Validate token
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    // If a contract_address is provided, make sure it belongs to this server
    if (contract_address) {
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const mints = (st||[]).map(r=>r.contract_address);
      if (!mints.includes(contract_address)) {
        return res.status(400).json({ error:'Invalid token for this server' });
      }
    }

    // Build local "today" (CR) and start date
    const nowUTC = new Date();
    const localToday = new Date(nowUTC.getTime() + tz*60*1000);
    const localStart = (range === 'all')
      ? null
      : addDays(new Date(Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate())), -29); // past30 local

    // Translate localStart back to UTC for querying
    const queryStartUTC = localStart ? new Date(localStart.getTime() - tz*60*1000) : null;

    // Pull spins (current + legacy compatible; same table name as before)
    let q = supabase.from('daily_spins').select('created_at,reward,contract_address');
    if (queryStartUTC) q = q.gte('created_at', queryStartUTC.toISOString());
    if (contract_address) q = q.eq('contract_address', contract_address);
    const { data: spins, error: spinsErr } = await q;
    if (spinsErr) return res.status(400).json({ error: spinsErr.message });

    // If "all" range and we have older rows, extend localStart to first row (local)
    let effectiveLocalStart = localStart;
    if (range === 'all') {
      let first = null;
      for (const s of spins||[]) {
        const d = new Date(s.created_at);
        if (!first || d < first) first = d;
      }
      if (first) {
        const firstLocalMidnight = new Date(Date.UTC(
          (new Date(first.getTime() + tz*60*1000)).getUTCFullYear(),
          (new Date(first.getTime() + tz*60*1000)).getUTCMonth(),
          (new Date(first.getTime() + tz*60*1000)).getUTCDate()
        ));
        effectiveLocalStart = firstLocalMidnight;
      } else {
        effectiveLocalStart = addDays(new Date(Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate())), -29);
      }
    }

    // Make buckets for every local day from start..today (inclusive)
    const buckets = {};
    const endLocalMidnight = new Date(Date.UTC(localToday.getUTCFullYear(), localToday.getUTCMonth(), localToday.getUTCDate()));
    let cur = new Date(effectiveLocalStart);
    while (ymd(cur) <= ymd(endLocalMidnight)) {
      buckets[ymd(cur)] = { count: 0, sum: 0 };
      cur = addDays(cur, 1);
    }

    // Fill buckets
    for (const s of (spins||[])) {
      const utc = new Date(s.created_at);
      const key = localKeyFromUTC(utc, tz);
      if (!buckets[key]) buckets[key] = { count: 0, sum: 0 }; // safety for out-of-range rows
      buckets[key].count += 1;
      buckets[key].sum   += Number(s.reward || 0);
    }

    const labels = Object.keys(buckets).sort();
    const spinsSeries = labels.map(k => buckets[k].count);
    const avgSeries   = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);

    const chartData = {
      labels,
      datasets: [
        { label:'Spins', yAxisID:'y',  data: spinsSeries, borderWidth:2, pointRadius:0, tension:0.2 },
        { label:'Avg Payout', yAxisID:'y1', data: avgSeries,  borderWidth:2, pointRadius:0, tension:0.2 }
      ]
    };

    return res.status(200).json({ chartData, options: {} });
  }catch(e){
    console.error('chart error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
