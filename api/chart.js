import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- time helpers (local-day bucketing using client tz offset) ----
function toYMDFromLocal(dateUtc, tzOffsetMin) {
  // shift UTC -> local by subtracting offset (so 00:00 local buckets correctly)
  const shifted = new Date(dateUtc.getTime() - tzOffsetMin * 60000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfLocalDayUtc(nowUtc, tzOffsetMin) {
  const shifted = new Date(nowUtc.getTime() - tzOffsetMin * 60000); // to local
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const localMidnightShifted = new Date(Date.UTC(y, m, d, 0, 0, 0));
  // convert back to UTC timeline by adding tz offset
  return new Date(localMidnightShifted.getTime() + tzOffsetMin * 60000);
}

function addDaysUTC(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// ---- DB helpers (be tolerant to schema variations) ----
async function safeSelect(table, columns, filters = []) {
  try {
    let q = supabase.from(table).select(columns);
    for (const f of filters) {
      const [fn, ...args] = f;
      q = q[fn](...args);
    }
    const { data, error } = await q;
    if (error) return { data: null, error };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

async function fetchSpinsSince(startIso, contractAddress) {
  // Try a few combos: table & created column names (legacy vs. new)
  const attempts = [
    { table: 'daily_spins', createdCol: 'created_at', rewardCol: 'reward', mintCol: 'contract_address' },
    { table: 'daily_spins', createdCol: 'created',    rewardCol: 'reward', mintCol: 'contract_address' },
    { table: 'spins',       createdCol: 'created_at', rewardCol: 'reward', mintCol: 'contract_address' },
    { table: 'spins',       createdCol: 'created',    rewardCol: 'reward', mintCol: 'contract_address' },
    { table: 'spin_results',createdCol: 'created_at', rewardCol: 'amount', mintCol: 'contract' },
  ];

  const all = [];
  for (const a of attempts) {
    const cols = `${a.createdCol},${a.rewardCol},${a.mintCol}`;
    const filters = [['gte', a.createdCol, startIso]];
    if (contractAddress) filters.push(['eq', a.mintCol, contractAddress]);

    const { data, error } = await safeSelect(a.table, cols, filters);
    if (data && Array.isArray(data)) {
      // normalize rows to { created_at, reward, contract_address }
      for (const r of data) {
        const created_at = r[a.createdCol];
        const reward = Number(r[a.rewardCol] ?? 0);
        const contract_address = r[a.mintCol];
        if (created_at) all.push({ created_at, reward, contract_address });
      }
    } else if (error) {
      // Only log; move to next attempt
      console.log(`[chart] skip ${a.table}.${a.createdCol}: ${error.message || error}`);
    }
  }
  return all;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, contract_address, range, tzOffsetMinutes } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Validate token
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // Optional: verify contract belongs to server
    if (contract_address) {
      const { data: st, error: stErr } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (stErr) return res.status(400).json({ error: stErr.message });
      const mints = (st || []).map(r => r.contract_address);
      if (!mints.includes(contract_address)) {
        return res.status(400).json({ error: 'Invalid token for this server' });
      }
    }

    const tzOffsetMin = Number.isFinite(+tzOffsetMinutes) ? +tzOffsetMinutes : 360; // default 360 = UTC-6 (Costa Rica)
    const nowUtc = new Date();

    // Determine local-window start (in UTC timeline)
    let localStartUtc;
    if (range === 'all') {
      // Find very first record across all known tables (best-effort)
      // fallback to 30 days if none
      const thirtyDaysAgo = addDaysUTC(nowUtc, -29);
      // we’ll just use 90 days back to be generous when "all" without heavy scans
      localStartUtc = addDaysUTC(nowUtc, -89);
      // (If needed we could scan earliest row here; kept simple/fast.)
    } else {
      // past30 = last 30 local days including today
      const todayLocalStartUtc = startOfLocalDayUtc(nowUtc, tzOffsetMin);
      localStartUtc = addDaysUTC(todayLocalStartUtc, -29);
    }

    // For DB query, we need UTC ISO lower bound:
    const queryStartIso = localStartUtc.toISOString();

    // Pull spins from any supported table/column combo
    const spins = await fetchSpinsSince(queryStartIso, contract_address);

    // Build daily buckets by LOCAL day key (so recent days don’t show as 0)
    // Ensure the sequence includes every day up to "today (local)"
    const todayLocalStartUtc = startOfLocalDayUtc(nowUtc, tzOffsetMin);
    const buckets = {};
    for (
      let d = new Date(localStartUtc);
      d.getTime() <= todayLocalStartUtc.getTime();
      d = addDaysUTC(d, 1)
    ) {
      const key = toYMDFromLocal(d, tzOffsetMin); // label as local day
      buckets[key] = { count: 0, sum: 0 };
    }

    for (const s of spins) {
      const created = new Date(s.created_at);
      const key = toYMDFromLocal(created, tzOffsetMin);
      if (!buckets[key]) buckets[key] = { count: 0, sum: 0 }; // in case of wider fetch
      buckets[key].count += 1;
      buckets[key].sum += Number(s.reward || 0);
    }

    const labels = Object.keys(buckets).sort();
    const spinsSeries = labels.map(k => buckets[k].count);
    const avgSeries   = labels.map(k => buckets[k].count ? +(buckets[k].sum / buckets[k].count).toFixed(2) : 0);

    const chartData = {
      labels,
      datasets: [
        { label: 'Spins',      yAxisID: 'y',  data: spinsSeries, borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Avg Payout', yAxisID: 'y1', data: avgSeries,   borderWidth: 2, pointRadius: 0, tension: 0.2 }
      ]
    };

    return res.status(200).json({ chartData, options: {} });
  } catch (e) {
    console.error('chart error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
