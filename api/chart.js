import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- helpers: UTC-only bucketing (no timezone surprises) ----
function ymdUTC(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function addDaysUTC(d,n){ const x=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate()+n); return x; }

async function safeSelect(table, columns, build){
  try{
    const q = supabase.from(table).select(columns);
    const { data, error } = build ? await build(q) : await q;
    if (error) return [];
    return data || [];
  }catch{ return []; }
}

async function fetchServerTokens(server_id){
  try{
    const { data, error } = await supabase.from('server_tokens').select('contract_address, enabled').eq('server_id', server_id);
    if (error) throw error;
    return (data||[]).map(r=>String(r.contract_address||'').trim()).filter(Boolean);
  }catch(e){
    const msg = ((e?.message||'') + ' ' + (e?.details||'')).toLowerCase();
    if (msg.includes('enabled')) {
      const fb = await supabase.from('server_tokens').select('contract_address').eq('server_id', server_id);
      if (fb.error) return [];
      return (fb.data||[]).map(r=>String(r.contract_address||'').trim()).filter(Boolean);
    }
    return [];
  }
}

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

  try{
    const { token, server_id, contract_address, range='past30' } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error:'token and server_id required' });

    // just validate token exists
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    const allowed = new Set(await fetchServerTokens(server_id));
    let mints;
    if (contract_address) {
      if (!allowed.has(contract_address)) return res.status(400).json({ error:'Invalid token for this server' });
      mints = [contract_address];
    } else {
      mints = Array.from(allowed);
    }

    // UTC calendar days
    const todayUTC = new Date(); // now
    const endDay   = addDaysUTC(todayUTC, 0); // include today
    const startDay = (range === 'all') ? null : addDaysUTC(endDay, -29);

    const startIso = startDay ? addDaysUTC(startDay, -1).toISOString() : undefined; // 1-day buffer
    const endIso   = addDaysUTC(endDay, 1).toISOString(); // +1 buffer

    const read = async (table) => safeSelect(
      table, 'created_at, reward, contract_address',
      q => {
        let qq = q;
        if (startIso) qq = qq.gte('created_at', startIso);
        qq = qq.lte('created_at', endIso);
        if (mints.length) qq = qq.in('contract_address', mints);
        return qq;
      }
    );

    let rows = await read('daily_spins');
    rows = rows.concat(
      await read('spins'),
      await read('wheel_spins')
    );

    // dynamic start for "all"
    const bucketStart = (range === 'all')
      ? (rows.length ? addDaysUTC(new Date(rows.reduce((min, r)=> Math.min(min, +new Date(r.created_at)), +new Date())).toISOString(), 0) : addDaysUTC(endDay, -29))
      : startDay;

    // build buckets by UTC date
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
          { label:'Spins', yAxisID:'y',  data: spinsSeries, borderWidth:2, pointRadius:0, tension:0.2 },
          { label:'Avg Payout', yAxisID:'y1', data: avgSeries, borderWidth:2, pointRadius:0, tension:0.2 }
        ]
      },
      options: {}
    });
  }catch(e){
    console.error('chart fatal:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
