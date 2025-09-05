import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Harold (and your current SPL prizes) use 5 decimals.
// If you later add per-mint decimals, swap this to a lookup.
const DEFAULT_DECIMALS = 5;
const EASTERN_TZ = 'America/New_York';

function getRangeBounds(range) {
  const nowUtc = new Date(); // UTC now
  if (range === 'all') {
    // return a safe wide window (2 years)
    const startUtc = new Date(nowUtc.getTime() - 730 * 24 * 3600 * 1000);
    return { startUtc, endUtc: nowUtc, days: 730 };
  }
  const days = range === 'past7' ? 7 : 30;
  const startUtc = new Date(nowUtc.getTime() - days * 24 * 3600 * 1000);
  return { startUtc, endUtc: nowUtc, days };
}

// Format a Date into YYYY-MM-DD in US/Eastern (EDT/EST aware) without time.
function easternDayKey(d) {
  // Use en-CA to get ISO-like yyyy-mm-dd
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Build a continuous list of day keys between start and end (in US/Eastern days).
function buildDaySeries(startUtc, endUtc) {
  // Walk by UTC day but label by Eastern; that still covers all rows and we’ll map by key.
  const labels = [];
  const cursor = new Date(startUtc);
  // Snap cursor to 00:00 Eastern of its day, then move forward by 1 day each loop.
  // Simpler: just push unique easternDayKey until we pass endUtc.
  const seen = new Set();
  while (cursor <= endUtc) {
    const key = easternDayKey(cursor);
    if (!seen.has(key)) {
      labels.push(key);
      seen.add(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  // Ensure end day is present
  const endKey = easternDayKey(endUtc);
  if (!seen.has(endKey)) labels.push(endKey);
  return labels;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const {
      server_id,
      contract_address, // present => token view; absent => server view
      range = 'past30',
    } = req.body || {};

    if (!server_id) {
      return res.status(400).json({ error: 'server_id required' });
    }

    const { startUtc, endUtc } = getRangeBounds(range);
    const labels = buildDaySeries(startUtc, endUtc);

    // Fetch normalized rows for the window.
    // We aggregate in JS for predictable behavior and to guarantee day filling.
    let query = supabase
      .from('daily_spins')
      .select('created_at_utc, amount_base, contract_address')
      .eq('server_id', server_id)
      .gte('created_at_utc', startUtc.toISOString())
      .lte('created_at_utc', endUtc.toISOString());

    if (contract_address) {
      query = query.eq('contract_address', contract_address);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    // Prepare per-day accumulators
    const dayCount = Object.create(null);
    const daySumBase = Object.create(null); // only used in token view

    // Initialize all labels to 0s so Chart.js never sees sparse points
    for (const k of labels) {
      dayCount[k] = 0;
      daySumBase[k] = 0;
    }

    // Aggregate
    for (const r of rows || []) {
      if (!r.created_at_utc) continue;
      const key = easternDayKey(new Date(r.created_at_utc));
      if (!(key in dayCount)) continue; // outside computed label range (very unlikely)
      dayCount[key] += 1;
      if (contract_address) {
        const base = Number(r.amount_base || 0);
        if (!Number.isNaN(base)) daySumBase[key] += base;
      }
    }

    // Build aligned data arrays
    const spinsData = labels.map((k) => dayCount[k] || 0);

    let payoutData = null;
    if (contract_address) {
      const denom = Math.pow(10, DEFAULT_DECIMALS);
      payoutData = labels.map((k) => (daySumBase[k] || 0) / denom);
    }

    // Compose Chart.js payload
    const datasets = [
      {
        label: 'Spins',
        data: spinsData,
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0,
      },
    ];

    if (payoutData) {
      datasets.push({
        label: 'Total Payout',
        data: payoutData,
        yAxisID: 'y1',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0,
      });
    }

    const chartData = {
      labels,
      datasets,
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#ddd' } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { ticks: { color: '#bbb', maxRotation: 70, minRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: {
          position: 'left',
          beginAtZero: true,
          ticks: { color: '#bbb' },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: '# Spins', color: '#bbb' },
        },
        ...(contract_address
          ? {
              y1: {
                position: 'right',
                beginAtZero: true,
                ticks: { color: '#bbb' },
                grid: { drawOnChartArea: false },
                title: { display: true, text: 'Total Payout', color: '#bbb' },
              },
            }
          : {}),
      },
    };

    return res.status(200).json({ chartData, options });
  } catch (e) {
    console.error('chart api error:', e);
    return res.status(500).json({ error: 'Chart API failed' });
  }
}
