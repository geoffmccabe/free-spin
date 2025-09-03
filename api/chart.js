import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// UTC helpers
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30' } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // lite token check (existence)
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // time window
    const now = new Date();
    const todayUTC = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fetchStart = addDays(todayUTC, -60); // wide fetch window
    let startDay = addDays(todayUTC, -29);
    let endDay = todayUTC;

    // primary path: read by server_id directly
    let q = supabase.from('daily_spins')
      .select('created_at,reward')
      .eq('server_id', server_id)
      .gte('created_at', fetchStart.toISOString());

    let { data: rows, error } = await q;

    // fallback once (for any older rows that didn't have server_id yet):
    if (!error && (!rows || rows.length === 0)) {
      const { data: st, error: stErr } = await supabase
        .from('server_tokens').select('contract_address').eq('server_id', server_id);
      if (!stErr && st && st.length) {
        const mints = st.map(r => String(r.contract_address||'').trim()).filter(Boolean);
        if (mints.length) {
          const retry = await supabase.from('daily_spins')
            .select('created_at,reward,contract_address')
            .gte('created_at', fetchStart.toISOString())
            .in('contract_address', mints);
          rows = retry.data || [];
        }
      }
    }
    if (!rows) rows = [];

    if (range === 'all') {
      const min = rows.length ? rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +todayUTC) : +todayUTC;
      const md = new Date(min);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // seed buckets (UTC calendar days)
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= ymdUTC(endDay); d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }

    // fill buckets
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (key >= ymdUTC(startDay) && key <= ymdUTC(endDay)) {
        if (!buckets[key]) buckets[key] = { count: 0, sum: 0 };
        buckets[key].count += 1;
        buckets[key].sum   += Number(r.reward || 0);
      }
    }

    const labels = Object.keys(buckets).sort();
    const spins = labels.map(k => buckets[k].count);
    const avg   = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);

    return res.status(200).json({
      chartData: {
        labels,
        datasets: [
          { label:'Spins', yAxisID:'y',  data: spins, borderWidth:2, pointRadius:0, tension:0.2 },
          { label:'Avg Payout', yAxisID:'y1', data: avg, borderWidth:2, pointRadius:0, tension:0.2 }
        ]
      },
      options: {}
    });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
