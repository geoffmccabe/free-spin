import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* UTC date helpers */
function dayUTC(y,m,d){ return new Date(Date.UTC(y,m,d)); }
function addDays(d,n){ const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate()+n); return x; }
function ymdUTC(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Resolve default mint from the link if caller didn’t pass one
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('contract_address')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const mint = (contract_address && String(contract_address).trim()) || (tok.contract_address || '').trim();
    const perToken = !!mint;

    // Build UTC window
    const now = new Date();
    const today = dayUTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let startDay = addDays(today, -29);
    let endDay   = today;

    // If "all time", we’ll extend start after we know earliest data (server view only).
    // For token view the RPC handles the window we pass.

    if (perToken) {
      // ---- Per-token: DB-side daily grouping (UTC), minted rows only; includes TODAY; total payout line ----
      const rpc = await supabase.rpc('chart_token_stats_v1', {
        p_mint: mint,
        p_start: ymdUTC(startDay),
        p_end:   ymdUTC(endDay)
      });
      if (rpc.error) return res.status(400).json({ error: rpc.error.message });

      const labels = rpc.data.map(r => r.day_utc);
      const spins  = rpc.data.map(r => Number(r.spins || 0));
      const totals = rpc.data.map(r => Number(r.total_payout || 0));

      return res.status(200).json({
        chartData: {
          labels,
          datasets: [
            { label: 'Spins',        yAxisID: 'y',  data: spins,  borderWidth: 2, pointRadius: 0, tension: 0.25 },
            { label: 'Total Payout', yAxisID: 'y1', data: totals, borderWidth: 2, pointRadius: 0, tension: 0.25 }
          ]
        },
        options: {}
      });
    }

    // ---- Server-wide view (spins only; no payouts; combine stamped + server legacy mints) ----
    // Window as above
    const startISO = ymdUTC(startDay) + 'T00:00:00Z';
    const endISO   = ymdUTC(addDays(endDay,1)) + 'T00:00:00Z';

    let rows = [];

    // stamped rows for this server
    {
      const a = await supabase
        .from('daily_spins')
        .select('created_at')
        .eq('server_id', server_id)
        .gte('created_at', startISO)
        .lt('created_at', endISO);
      if (a.error) return res.status(400).json({ error: a.error.message });
      rows = rows.concat(a.data || []);
    }

    // plus legacy (server_id NULL) for mints owned by this server
    {
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const mints = (st || []).map(r => String(r.contract_address||'').trim()).filter(Boolean);

      if (mints.length) {
        const b = await supabase
          .from('daily_spins')
          .select('created_at,contract_address')
          .is('server_id', null)
          .in('contract_address', mints)
          .gte('created_at', startISO)
          .lt('created_at', endISO);
        if (b.error) return res.status(400).json({ error: b.error.message });
        rows = rows.concat(b.data || []);
      }
    }

    // Bucket by UTC day
    const buckets = {};
    for (let d = startDay; ymdUTC(d) <= ymdUTC(endDay); d = addDays(d, 1)) {
      buckets[ymdUTC(d)] = 0;
    }
    for (const r of rows) {
      const k = ymdUTC(new Date(r.created_at));
      if (k in buckets) buckets[k] += 1;
    }

    const labels = Object.keys(buckets).sort();
    const spins  = labels.map(k => buckets[k]);

    return res.status(200).json({
      chartData: {
        labels,
        datasets: [
          { label: 'Spins', yAxisID: 'y', data: spins, borderWidth: 2, pointRadius: 0, tension: 0.25 }
        ]
      },
      options: {}
    });

  } catch (e) {
    console.error('chart fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
