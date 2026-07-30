// /api/chart.js
// Returns { labels, spins, totalPayout, yMaxLeft, yMaxRight, token_name, decimals }
// Buckets daily_spins by day in the caller's timezone. Admin-only.
//
// This endpoint was doubly broken:
//  1. It selected `created_at_utc` and `amount_base`, neither of which exists on
//     daily_spins (the real columns are `created_at` and `payout_amount_raw`), so
//     PostgREST rejected the query and every request 500'd.
//  2. Even had it worked, it returned { days: [...] } while adminpanel.html reads
//     { labels, spins, totalPayout }, so the chart would have rendered empty.
// It also required contract_address, which made the panel's "All tokens" view a
// guaranteed 400, and hardcoded decimals to 5 regardless of the token.

import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../lib/auth.js';
import { selectAllRows } from '../lib/fetchAll.js';

function jsonError(res, status, message, details) {
  res.status(status).json({ error: message, details });
}

function rangeToStart(range) {
  const now = Date.now();
  if (range === '7d') return new Date(now - 6 * 24 * 3600 * 1000);
  if (range === '30d') return new Date(now - 29 * 24 * 3600 * 1000);
  if (range === '90d') return new Date(now - 89 * 24 * 3600 * 1000);
  if (range === 'all') return null;
  return new Date(now - 29 * 24 * 3600 * 1000);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonError(res, 500, 'Missing Supabase server env vars');
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Accept params from POST body (admin panel) or query string.
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const {
      token,
      server_id,
      contract_address,
      view = contract_address ? 'token' : 'server',
      tz = 'America/New_York',
      range = '30d',
    } = src;

    if (!server_id) return jsonError(res, 400, 'server_id required');
    if (view === 'token' && !contract_address) {
      return jsonError(res, 400, 'contract_address required for token view');
    }

    // Admin-only: spin stats must not be world-readable.
    const gate = await requireAdmin(supabase, token, server_id);
    if (!gate.ok) return jsonError(res, gate.status, gate.error);

    // Per-mint decimals for this server, so payouts scale correctly in both views.
    const { data: cfgs } = await supabase
      .from('wheel_configurations')
      .select('contract_address, token_name, decimals')
      .eq('server_id', server_id);

    const decimalsByMint = new Map();
    const nameByMint = new Map();
    for (const c of cfgs || []) {
      const d = Number(c.decimals);
      decimalsByMint.set(c.contract_address, Number.isFinite(d) ? d : 0);
      if (c.token_name) nameByMint.set(c.contract_address, c.token_name);
    }

    const token_name = view === 'token'
      ? (nameByMint.get(contract_address) || 'TOKEN')
      : 'All tokens';
    const decimals = view === 'token' ? (decimalsByMint.get(contract_address) ?? 0) : 0;

    const start = rangeToStart(range);

    const { data: rows, error } = await selectAllRows(() => {
      let q = supabase
        .from('daily_spins')
        .select('created_at, payout_amount_raw, contract_address')
        .eq('server_id', server_id)
        .order('created_at', { ascending: true });
      if (view === 'token') q = q.eq('contract_address', contract_address);
      if (start) q = q.gte('created_at', start.toISOString());
      return q;
    });

    if (error) return jsonError(res, 500, 'DB fetch error', error.message);

    // Aggregate by day in the requested timezone (en-CA formats as YYYY-MM-DD)
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });

    const dayMap = new Map();
    for (const r of rows || []) {
      if (!r.created_at) continue;
      const d = new Date(r.created_at);
      if (Number.isNaN(d.getTime())) continue;
      const day = fmt.format(d);

      const base = r.payout_amount_raw != null
        ? Number(String(r.payout_amount_raw).split('.')[0])
        : 0;
      const dec = decimalsByMint.get(r.contract_address) ?? decimals;
      const amt = Number.isFinite(base) ? base / (10 ** dec) : 0;

      const cur = dayMap.get(day) || { spins: 0, payout: 0 };
      cur.spins += 1;
      cur.payout += amt;
      dayMap.set(day, cur);
    }

    // Fill gap days so the line chart doesn't imply activity across empty stretches
    const sortedDays = Array.from(dayMap.keys()).sort();
    const labels = [];
    if (sortedDays.length) {
      const cursor = new Date(`${sortedDays[0]}T00:00:00Z`);
      const last = new Date(`${sortedDays[sortedDays.length - 1]}T00:00:00Z`);
      while (cursor <= last) {
        labels.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const spins = labels.map(l => dayMap.get(l)?.spins || 0);
    const totalPayout = labels.map(l => Number((dayMap.get(l)?.payout || 0).toFixed(6)));

    return res.status(200).json({
      labels,
      spins,
      totalPayout,
      yMaxLeft: Math.max(1, ...spins),
      yMaxRight: Math.max(1, ...totalPayout),
      token_name,
      decimals,
    });
  } catch (e) {
    return jsonError(res, 500, 'Unhandled chart error', String(e?.message || e));
  }
}
