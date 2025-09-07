// /api/chart.js
// Returns { days: [{ day_et, spins, total_base }], token_name, decimals }
// Filters by server_id + contract_address; buckets by US/Eastern; never returns plain text.

import { createClient } from '@supabase/supabase-js';

function jsonError(res, status, message, details) {
  res.status(status).json({ error: message, details });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(res, 500, 'Missing Supabase server env vars');
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Required query params
    const { server_id, contract_address, tz = 'America/New_York', range = 'all' } = req.query || {};
    if (!server_id || !contract_address) {
      return jsonError(res, 400, 'server_id and contract_address required');
    }

    // Token label (decimals default to 5; we avoid selecting non-existent columns)
    let token_name = 'TOKEN';
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name')
      .eq('contract_address', contract_address)
      .maybeSingle();
    if (!cfgErr && cfg?.token_name) token_name = cfg.token_name;
    const decimals = 5;

    // Fetch all rows for this server+token (sorted)
    const { data: rows, error } = await supabase
      .from('daily_spins')
      .select('created_at_utc, created_at, amount_base')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address)
      .order('created_at_utc', { ascending: true, nullsFirst: false });

    if (error) {
      return jsonError(res, 500, 'DB fetch error', error.message);
    }

    // Aggregate by ET day (YYYY-MM-DD)
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const dayMap = new Map();

    for (const r of rows || []) {
      const ts = r.created_at_utc || r.created_at;
      if (!ts) continue;
      const d = new Date(ts);
      const day_et = fmt.format(d); // en-CA gives YYYY-MM-DD
      const amt = Number(r.amount_base) || 0;

      const cur = dayMap.get(day_et) || { day_et, spins: 0, total_base: 0 };
      cur.spins += 1;
      cur.total_base += amt;
      dayMap.set(day_et, cur);
    }

    let days = Array.from(dayMap.values()).sort((a, b) => (a.day_et < b.day_et ? -1 : 1));

    // Optional range trimming
    if (range === '7d' || range === '30d' || range === '90d') {
      const nowTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const back = range === '7d' ? 7 : range === '30d' ? 30 : 90;
      const cutoff = new Date(nowTz);
      cutoff.setDate(cutoff.getDate() - back);
      const y = cutoff.getFullYear();
      const m = String(cutoff.getMonth() + 1).padStart(2, '0');
      const d2 = String(cutoff.getDate()).padStart(2, '0');
      const cut = `${y}-${m}-${d2}`;
      days = days.filter(x => x.day_et >= cut);
    }

    return res.status(200).json({ days, token_name, decimals });
  } catch (e) {
    return jsonError(res, 500, 'Unhandled chart error', String(e?.message || e));
  }
}
