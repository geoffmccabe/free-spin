import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- helpers: UTC-only bucketing ----
function ymdUTC(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function addDaysUTC(d,n){ const x=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate()+n); return x; }

// Try a targeted select first; if the table/columns differ, fall back to select('*') and normalize in JS.
async function readFlexible(table, mints, startIso, endIso) {
  // Attempt 1: standard shape
  try{
    let q = supabase.from(table).select('created_at,reward,contract_address');
    if (startIso) q = q.gte('created_at', startIso);
    if (endIso)   q = q.lte('created_at', endIso);
    if (mints?.length) q = q.in('contract_address', mints);
    const { data, error } = await q;
    if (!error && Array.isArray(data)) return data.map(r => ({
      created_at: r.created_at, reward: Number(r.reward || 0), contract_address: r.contract_address
    }));
  }catch(_e){}

  // Attempt 2: full rows + normalize
  try{
    let q = supabase.from(table).select('*');
    if (mints?.length) q = q.in('contract_address', mints).or(mints.map(()=>`contract_address.is.null`).join(',')); // best-effort keep results
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return [];
    const tsKeys = ['created_at','createdAt','created','inserted_at','insertedAt','timestamp','time','ts','date','datetime'];
    const amtKeys = ['reward','amount','payout','payout_amount','value'];
    const addrKeys= ['contract_address','mint','token_mint','address','contract','token'];

    return data.map(r => {
      const tsKey = tsKeys.find(k => r[k] != null);
      const amtKey= amtKeys.find(k => r[k] != null);
      const adKey = addrKeys.find(k => r[k] != null);
      return {
        created_at: tsKey ? r[tsKey] : null,
        reward: amtKey ? Number(r[amtKey] || 0) : 0,
        contract_address: adKey ? String(r[adKey]) : null
      };
    }).filter(x => x.created_at);
  }catch(_e){ return []; }
}

async function fetchServerMints(server_id){
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

    const allowed = new Set(await fetchServerMints(server_id));
    let mints;
    if (contract_address) {
      if (!allowed.has(contract_address)) return res.status(400).json({ error:'Invalid token for this server' });
      mints = [contract_address];
    } else {
      mints = Array.from(allowed);
    }

    // Build time window (UTC) with a small buffer to catch delayed writes
    const now = new Date();
    const endDay = addDaysUTC(now, 0);               // today
    const startDay = (range === 'all') ? null : addDaysUTC(endDay, -29);
    const startIso = startDay ? addDaysUTC(startDay, -1).toISOString() : undefined; // small buffer
    const endIso = addDaysUTC(endDay, 1).toISOString();

    // Pull from current + legacy, normalizing as needed
    let rows = [];
    rows = rows.concat(await readFlexible('daily_spins', mints, startIso, endIso));
    rows = rows.concat(await readFlexible('spins',       mints, startIso, endIso));
    rows = rows.concat(await readFlexible('wheel_spins', mints, startIso, endIso));

    // If "all", compute dynamic start; else use the 30-day window
    const bucketStart = (range === 'all')
      ? (rows.length ? addDaysUTC(new Date(rows.reduce((min, r)=> Math.min(min, +new Date(r.created_at)), +new Date())).toISOString(), 0) : addDaysUTC(endDay, -29))
      : startDay;

    // Buckets per UTC date
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
