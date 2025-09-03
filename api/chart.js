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
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // existence check only
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // time window (UTC)
    const now = new Date();
    const todayUTC = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fetchStart = addDays(todayUTC, -90); // wide fetch window
    let startDay = addDays(todayUTC, -29);     // default past 30
    let endDay   = todayUTC;

    // fetch the server's mints (enabled or disabled)
    const { data: st, error: stErr } = await supabase
      .from('server_tokens').select('contract_address').eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const mints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

    const perToken = !!contract_address; // if a specific mint is requested

    // Query rows
    let rows = [];
    if (perToken) {
      // Specific token:
      // A) rows that already have server_id
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows without server_id but matching the mint
      const b = await supabase.from('daily_spins')
        .select('created_at,reward')
        .is('server_id', null)
        .eq('contract_address', contract_address)
        .gte('created_at', fetchStart.toISOString());
      if (!b.error && b.data) rows = rows.concat(b.data);
    } else {
      // ALL tokens (server-wide):
      // A) rows that already have server_id
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows without server_id but with mint belonging to this server
      if (mints.length) {
        const b = await supabase.from('daily_spins')
          .select('created_at,reward,contract_address')
          .is('server_id', null)
          .gte('created_at', fetchStart.toISOString())
          .in('contract_address', mints);
        if (!b.error && b.data) rows = rows.concat(b.data);
      }
    }

    if (range === 'all') {
      const minTs = rows.length ? rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +todayUTC) : +todayUTC;
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // Seed buckets (UTC)
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= ymdUTC(endDay); d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }

    // Fill buckets
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

    const datasets = [
      { label:'Spins', yAxisID:'y', data: spins, borderWidth:2, pointRadius:0, tension:0.2 }
    ];

    // Only include Avg Payout line when charting a single token
    if (perToken) {
      const avg = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);
      datasets.push({ label:'Avg Payout', yAxisID:'y1', data: avg, borderWidth:2, pointRadius:0, tension:0.2 });
    }

    return res.status(200).json({
      chartData: { labels, datasets },
      options: {}
    });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
