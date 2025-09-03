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

    // token exists
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id, contract_address').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // prefer explicit contract_address; otherwise infer from the spin link's token
    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();

    // time window (UTC)
    const now = new Date();
    const todayUTC = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fetchStart = addDays(todayUTC, -90); // wide window to avoid any timezone edges
    let startDay = addDays(todayUTC, -29);
    let endDay   = todayUTC;

    // If we have a specific mint, we chart that token (Spins + Avg Payout).
    // Otherwise (no mint), we chart all tokens server-wide (Spins only).
    const perToken = !!effectiveMint;

    // Get server mints for legacy merge (server_id null rows)
    const { data: st, error: stErr } = await supabase
      .from('server_tokens').select('contract_address').eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const mints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

    let rows = [];

    if (perToken) {
      // A) rows stamped with server_id + this mint
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .eq('contract_address', effectiveMint)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows (server_id null) for this mint
      const b = await supabase.from('daily_spins')
        .select('created_at,reward')
        .is('server_id', null)
        .eq('contract_address', effectiveMint)
        .gte('created_at', fetchStart.toISOString());
      if (!b.error && b.data) rows = rows.concat(b.data);
    } else {
      // A) rows stamped with this server
      const a = await supabase.from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id)
        .gte('created_at', fetchStart.toISOString());
      if (!a.error && a.data) rows = rows.concat(a.data);

      // B) legacy rows (server_id null) but with a mint from this server
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

    // Seed buckets (UTC calendar days)
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

    if (perToken) {
      const avg = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);
      datasets.push({ label:'Avg Payout', yAxisID:'y1', data: avg, borderWidth:2, pointRadius:0, tension:0.2 });
    }

    return res.status(200).json({ chartData: { labels, datasets }, options: {} });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
