import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- utils ----
const CR_TZ_OFFSET_MIN = -360; // Costa Rica (no DST)

function ymdUTC(d){ const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
function addDaysUTC(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function atLocalMidnightUTC(baseUTC, tzOffsetMin){
  // Convert UTC -> local, floor to 00:00 local, then convert back to UTC instant
  const local = new Date(baseUTC.getTime() + tzOffsetMin*60*1000);
  const localMid = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  return new Date(localMid.getTime() - tzOffsetMin*60*1000);
}
async function safeSelect(table, columns, build){
  try{
    const q = supabase.from(table).select(columns);
    const { data, error } = build ? await build(q) : await q;
    if (error) return [];
    return data || [];
  }catch{ return []; }
}

// NEW: robust server_tokens fetch with fallback when `enabled` column doesn't exist
async function fetchServerTokens(server_id){
  try{
    const { data, error } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);
    if (error) throw error;
    return data || [];
  }catch(e){
    const msg = ((e?.message||'') + ' ' + (e?.details||'')).toLowerCase();
    if (msg.includes('enabled')) {
      const fb = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (fb.error) return [];
      return (fb.data || []).map(r => ({ contract_address: r.contract_address, enabled: true }));
    }
    return [];
  }
}

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

  try{
    const { token, server_id, contract_address, range = 'past30', tzOffsetMin = CR_TZ_OFFSET_MIN } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error:'token and server_id required' });

    // Validate token exists (we allow used tokens for charts)
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    // Allowed mints for this server (enabled + disabled; with fallback)
    const serverTokens = await fetchServerTokens(server_id);
    const allowed = new Set((serverTokens || []).map(r => r.contract_address));

    // If a specific mint is requested, validate it is in this server
    let filterMints;
    if (contract_address) {
      if (!allowed.has(contract_address)) return res.status(400).json({ error:'Invalid token for this server' });
      filterMints = [contract_address];
    } else {
      filterMints = Array.from(allowed);
    }

    // Local-day window
    const nowUTC = new Date();
    const endUTC = atLocalMidnightUTC(nowUTC, tzOffsetMin); // today @ 00:00 local (as UTC instant)
    const startUTC = (range === 'all') ? null : addDaysUTC(endUTC, -29); // 30 local days inclusive
    // 1-day buffer on both ends to catch skew
    const startUTCBuffered = startUTC ? addDaysUTC(startUTC, -1) : null;
    const endUTCBuffered = addDaysUTC(endUTC, 1);

    // Read rows from current + legacy (if present)
    const read = async (table) => safeSelect(
      table, 'created_at, reward, contract_address',
      q => {
        let qq = q;
        if (startUTCBuffered) qq = qq.gte('created_at', startUTCBuffered.toISOString());
        qq = qq.lte('created_at', endUTCBuffered.toISOString());
        if (filterMints.length) qq = qq.in('contract_address', filterMints);
        return qq;
      }
    );
    let rows = await read('daily_spins');
    const legacy1 = await read('spins');
    const legacy2 = await read('wheel_spins');
    rows = rows.concat(legacy1, legacy2);

    // If "all", extend the start to earliest local day we have
    let bucketStartUTC = startUTC;
    if (range === 'all') {
      let minUTC = null;
      for (const r of rows) { const d = new Date(r.created_at); if (!minUTC || d < minUTC) minUTC = d; }
      bucketStartUTC = minUTC ? atLocalMidnightUTC(minUTC, tzOffsetMin) : addDaysUTC(endUTC, -29);
    }

    // Build buckets for local days (keys are UTC-midnights representing those local days)
    const buckets = {};
    for (let d = bucketStartUTC; ymdUTC(d) <= ymdUTC(endUTC); d = addDaysUTC(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }

    for (const r of rows) {
      const utc = new Date(r.created_at);
      const localMidUTC = atLocalMidnightUTC(utc, tzOffsetMin);
      const key = ymdUTC(localMidUTC);
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
          { label:'Spins',      yAxisID:'y',  data: spinsSeries, borderWidth:2, pointRadius:0, tension:0.2 },
          { label:'Avg Payout', yAxisID:'y1', data: avgSeries,   borderWidth:2, pointRadius:0, tension:0.2 }
        ]
      },
      options: {}
    });
  }catch(e){
    console.error('chart error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
