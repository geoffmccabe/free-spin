// /api/chart.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Both HAROLD & FATCOIN use 5 decimals currently.
// If a new token has different decimals, you can extend this later with a lookup.
const DECIMALS = 5;

// Bucket days by US/Eastern (your business day)
const TZ = 'America/New_York';

function rangeBounds(range) {
  const now = new Date();
  if (range === 'all') {
    const start = new Date(now.getTime() - 730 * 24 * 3600 * 1000); // 2 years
    return { start, end: now };
  }
  const days = range === 'past7' ? 7 : 30;
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000);
  return { start, end: now };
}

// Format a Date into YYYY-MM-DD in US/Eastern
function dayKeyEDT(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

// Build array of EDT day keys from start..end (inclusive)
function dayKeys(start, end) {
  const keys = [];
  const seen = new Set();
  const cur = new Date(start);
  while (cur <= end) {
    const k = dayKeyEDT(cur);
    if (!seen.has(k)) {
      keys.push(k);
      seen.add(k);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return keys;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { server_id, contract_address, range = 'past30' } = req.body || {};
    if (!server_id) return res.status(400).json({ error: 'server_id required' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { start, end } = rangeBounds(range);
    const denom = Math.pow(10, DECIMALS);

    // Filter by created_at_utc for the time window, but SELECT created_at_ms so we never parse strings.
    let query = supabase
      .from('daily_spins')
      .select('created_at_ms, amount_base')
      .eq('server_id', server_id)
      .gte('created_at_utc', start.toISOString())
      .lte('created_at_utc', end.toISOString());

    const isTokenView = !!contract_address;
    if (isTokenView) query = query.eq('contract_address', contract_address);

    const { data: rows, error } = await query;
    if (error) throw error;

    // Prepare buckets
    const labels = dayKeys(start, end);
    const spinsByDay = Object.fromEntries(labels.map(k => [k, 0]));
    const payoutBaseByDay = Object.fromEntries(labels.map(k => [k, 0]));

    // Fill buckets using numeric epoch -> Date (no string parsing issues)
    for (const r of rows || []) {
      const ms = Number(r.created_at_ms);
      if (!Number.isFinite(ms)) continue;
      const key = dayKeyEDT(new Date(ms));
      if (!(key in spinsByDay)) continue; // outside range (defensive)
      spinsByDay[key] += 1;
      if (isTokenView) {
        const base = Number(r.amount_base || 0);
        if (Number.isFinite(base)) payoutBaseByDay[key] += base;
      }
    }

    // Build datasets for Chart.js
    const spins = labels.map(k => spinsByDay[k]);
    const datasets = [
      {
        label: 'Spins',
        data: spins,
        yAxisID: 'y',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0
      }
    ];

    if (isTokenView) {
      const payoutsDisplay = labels.map(k => payoutBaseByDay[k] / denom);
      datasets.push({
        label: 'Total Payout',
        data: payoutsDisplay,
        yAxisID: 'y1',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 0
      });
    }

    // Return Chart.js config
    return res.status(200).json({
      chartData: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#ddd' } }, tooltip: { enabled: true } },
        scales: {
          x: {
            ticks: { color: '#bbb', maxRotation: 70, minRotation: 45 },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          y: {
            position: 'left',
            beginAtZero: true,
            ticks: { color: '#bbb' },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: '# Spins', color: '#bbb' }
          },
          ...(isTokenView
            ? {
                y1: {
                  position: 'right',
                  beginAtZero: true,
                  ticks: { color: '#bbb' },
                  grid: { drawOnChartArea: false },
                  title: { display: true, text: 'Total Payout', color: '#bbb' }
                }
              }
            : {})
        }
      }
    });
  } catch (e) {
    console.error('chart error', e);
    return res.status(500).json({ error: 'Chart failed' });
  }
}
