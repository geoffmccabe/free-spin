import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
// default 5 decimals unless you add a `decimals` column somewhere later
const DEFAULT_DECIMALS = 5;

// Helper: Eastern day key "YYYY-MM-DD"
function easternDayKey(iso) {
  // robust even on serverless: use Intl with tz
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', { // en-CA yields YYYY-MM-DD
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(d); // e.g., "2025-09-04"
}

// Build continuous list of day keys from start..end (Eastern)
function enumerateEasternDays(startUtc, endUtc) {
  const out = [];
  let cur = new Date(startUtc);
  // normalize to 00:00 Eastern for the current date
  // by converting the day key back into a Date at midnight Eastern
  function easternMidnight(isoDate) {
    // Construct midnight Eastern by parsing yyyy-mm-dd as local then shifting using tz
    const [y, m, d] = isoDate.split('-').map(Number);
    // Create a Date at midnight UTC and then shift by the offset between UTC and Eastern midnight
    // Simpler: just keep incrementing by 1 day via the label list instead of Date math here.
    return `${isoDate}`; // we only need labels, not real Date objects
  }

  const startKey = easternDayKey(startUtc);
  const endKey   = easternDayKey(endUtc);

  // iterate by 1 day using UTC date add; labels will be recomputed by easternDayKey
  const end = new Date(endUtc);
  while (cur <= end) {
    out.push(easternDayKey(cur.toISOString()));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  // Ensure at least start/end present
  if (out.length === 0) out.push(startKey);
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Expected JSON body (all callers you have today send these)
    // - server_id (required)
    // - contract_address (optional; if present we’re in “this token” mode)
    // - range: 'past30' | 'past7' | 'all' (optional, defaults to past30)
    // - scope: 'this_token' | 'server' (optional; inferred from contract_address if missing)
    const {
      server_id,
      contract_address,
      range = 'past30',
      scope   // optional
    } = req.body || {};

    if (!server_id) {
      return res.status(400).json({ error: 'server_id required' });
    }

    const useTokenMode = !!contract_address || scope === 'this_token';

    // time window (UTC) — we’ll bucket to US/Eastern in memory
    const now = new Date();
    let startUtc;
    if (range === 'all') {
      // earliest spin for this server (cheap: try last 365 days; extend if you truly need all-time)
      // If you really want true all-time without limits, remove .gte below and trust PostgREST.
      const { data: minRows, error: minErr } = await supabase
        .from('daily_spins')
        .select('created_at_utc')
        .eq('server_id', server_id)
        .order('created_at_utc', { ascending: true })
        .limit(1);
      if (minErr) throw minErr;
      startUtc = minRows && minRows.length ? new Date(minRows[0].created_at_utc) : new Date(now.getTime() - 30*24*3600*1000);
    } else {
      const days = range === 'past7' ? 7 : 30;
      startUtc = new Date(now.getTime() - days*24*3600*1000);
    }
    const endUtc = now;

    // fetch only what we need; normalized columns only
    let query = supabase
      .from('daily_spins')
      .select('created_at_utc, amount_base, contract_address')
      .eq('server_id', server_id)
      .gte('created_at_utc', startUtc.toISOString())
      .lte('created_at_utc', endUtc.toISOString());

    if (useTokenMode) {
      query = query.eq('contract_address', contract_address);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    // Aggregate in memory per Eastern day
    const daySpins = new Map();        // key: 'YYYY-MM-DD' => count
    const dayPayoutBase = new Map();   // same key => sum base units (only token mode shows payouts)

    // zero-fill labels for the whole window
    const labels = enumerateEasternDays(startUtc.toISOString(), endUtc.toISOString());
    for (const k of labels) { daySpins.set(k, 0); dayPayoutBase.set(k, 0); }

    for (const r of rows || []) {
      if (!r.created_at_utc) continue; // defensive, but normalized table should have it
      const key = easternDayKey(r.created_at_utc);
      daySpins.set(key, (daySpins.get(key) || 0) + 1);
      if (useTokenMode) {
        const base = Number(r.amount_base || 0);
        if (!Number.isNaN(base)) {
          dayPayoutBase.set(key, (dayPayoutBase.get(key) || 0) + base);
        }
      }
    }

    // Convert base → display using DEFAULT_DECIMALS (you can swap to a mint-specific lookup later)
    const denom = Math.pow(10, DEFAULT_DECIMALS);
    const spinsSeries  = labels.map(k => daySpins.get(k) || 0);
    const payoutSeries = labels.map(k => useTokenMode ? (dayPayoutBase.get(k) || 0) / denom : 0);

    // Build Chart.js payload
    const chartData = {
      labels,
      datasets: [
        {
          label: 'Spins',
          data: spinsSeries,
          yAxisID: 'y',
          tension: 0.25
        },
        {
          label: useTokenMode ? 'Total Payout' : 'Total Payout (hidden on server view)',
          data: payoutSeries,
          yAxisID: 'y1',
          hidden: !useTokenMode,
          tension: 0.25
        }
      ]
    };

    const options = {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#ddd' } },
        tooltip: { enabled: true }
      },
      scales: {
        x:  { ticks: { color: '#bbb', autoSkip: true, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y:  { position: 'left',  ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '# Spins', color: '#bbb' } },
        y1: { position: 'right', ticks: { color: '#bbb' }, grid: { drawOnChartArea: false }, title: { display: useTokenMode, text: 'Total Payout', color: '#bbb' } }
      }
    };

    return res.status(200).json({ chartData, options });

  } catch (e) {
    console.error('chart api error:', e);
    return res.status(500).json({ error: 'Chart API failed' });
  }
}
