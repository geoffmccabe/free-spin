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

    // token exists?
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const effectiveMint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!effectiveMint;

    // window
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay = today;
    if (range === 'all') {
      // extend later after we fetch rows; default keeps UI fast
    }

    // build queries
    let rows = [];
    if (perToken) {
      // IMPORTANT: do NOT filter by server_id here (historic rows may lack it, and mint is unique per token)
      const q1 = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('contract_address', effectiveMint);
      if (!q1.error && q1.data) rows = rows.concat(q1.data);
    } else {
      // all tokens chart = this server only (plus legacy rows tied to this server's mints)
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const serverMints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

      const a = await supabase
        .from('daily_spins')
        .select('created_at,reward')
        .eq('server_id', server_id);
      if (!a.error && a.data) rows = rows.concat(a.data);

      if (serverMints.length) {
        const b = await supabase
          .from('daily_spins')
          .select('created_at,reward,contract_address')
          .is('server_id', null)
          .in('contract_address', serverMints);
        if (!b.error && b.data) rows = rows.concat(b.data);
      }
    }

    if (rows.length && range === 'all') {
      const minTs = rows.reduce((m, r) => Math.min(m, +new Date(r.created_at)), +today);
      const md = new Date(minTs);
      startDay = dayUTC(md.getUTCFullYear(), md.getUTCMonth(), md.getUTCDate());
    }

    // bucket by UTC day in [startDay, endDay]
    const startKey = ymdUTC(startDay), endKey = ymdUTC(endDay);
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= endKey; d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = { count: 0, sum: 0 };
    }
    for (const r of rows) {
      const key = ymdUTC(new Date(r.created_at));
      if (key >= startKey && key <= endKey) {
        (buckets[key] ||= { count: 0, sum: 0 });
        buckets[key].count += 1;
        buckets[key].sum += Number(r.reward || 0);
      }
    }

    const labels = Object.keys(buckets).sort();
    const spins = labels.map(k => buckets[k].count);

    const datasets = [
      { label: 'Spins', yAxisID: 'y', data: spins, borderWidth: 2, pointRadius: 0, tension: 0.2 }
    ];

    if (perToken) {
      const avg = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);
      datasets.push({ label: 'Avg Payout', yAxisID: 'y1', data: avg, borderWidth: 2, pointRadius: 0, tension: 0.2 });
    }

    return res.status(200).json({ chartData: { labels, datasets }, options: {} });
  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
