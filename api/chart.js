// chart.js — admin panel daily chart (Spins + Payouts)
// Assumes Chart.js is loaded in the page.
// Works with endpoints that return either:
//  A) { days: [{ day_et, spins, total_base, decimals }], decimals }
//  B) [ { day_et, spins, total_base, decimals } ]
//  C) { data: [ { day_et, spins, total_base, decimals } ] }
// Decimals default to 5 if not provided.

(function () {
  const qs = new URLSearchParams(location.search);
  const SERVER_ID = qs.get('server_id') || '';
  const CONTRACT = qs.get('contract_address') || qs.get('contract') || '';
  const TZ = 'America/New_York';

  // --- simple UI hooks (optional elements) ---
  const rangeSel = document.getElementById('range-select');   // values: 7d|30d|90d|all
  const canvas = document.getElementById('dailyChart');       // <canvas id="dailyChart">
  if (!canvas) {
    console.warn('chart.js: #dailyChart canvas not found - nothing to draw');
    return;
  }

  // Hard-cap the chart height to avoid giant canvas bug
  try {
    canvas.style.maxHeight = '420px';
    canvas.height = 420;
  } catch (_) {}

  // Fallback chain of endpoints (first that returns JSON wins)
  const endpoints = [
    `/api/adminchart?server_id=${encodeURIComponent(SERVER_ID)}&contract_address=${encodeURIComponent(CONTRACT)}&tz=${encodeURIComponent(TZ)}`,
    `/api/admin_chart?server_id=${encodeURIComponent(SERVER_ID)}&contract_address=${encodeURIComponent(CONTRACT)}&tz=${encodeURIComponent(TZ)}`,
    `/api/chart?server_id=${encodeURIComponent(SERVER_ID)}&contract_address=${encodeURIComponent(CONTRACT)}&tz=${encodeURIComponent(TZ)}`
  ];

  let chart;           // Chart.js instance
  let fullDays = [];   // canonical dataset from server

  function isValidDayRow(r) {
    return r && typeof r.day_et === 'string';
  }

  function coerceNumber(n, fallback = 0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
  }

  function normalizeResponse(json) {
    // Accept various shapes; return { days: [...], decimals }
    if (!json) return { days: [], decimals: 5 };

    if (Array.isArray(json)) {
      return { days: json, decimals: json[0]?.decimals ?? 5 };
    }
    if (Array.isArray(json.days)) {
      return { days: json.days, decimals: json.decimals ?? json.days[0]?.decimals ?? 5 };
    }
    if (Array.isArray(json.data)) {
      return { days: json.data, decimals: json.decimals ?? json.data[0]?.decimals ?? 5 };
    }
    // Unknown shape
    return { days: [], decimals: 5 };
  }

  async function fetchWithFallback() {
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) continue;

        // Some backends return errors as text; guard JSON parsing.
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          return normalizeResponse(json);
        } catch {
          // Not JSON, try next endpoint
          continue;
        }
      } catch {
        // try next
      }
    }
    throw new Error('No chart endpoint responded with valid JSON');
  }

  function filterByRange(days, range) {
    if (!Array.isArray(days) || days.length === 0) return [];
    if (range === 'all') return days;

    const now = new Date();
    let cutoff = new Date();
    switch (range) {
      case '7d':  cutoff.setDate(now.getDate() - 7); break;
      case '30d': cutoff.setDate(now.getDate() - 30); break;
      case '90d': cutoff.setDate(now.getDate() - 90); break;
      default:    return days;
    }
    // day_et is YYYY-MM-DD; include rows >= cutoff (ET already)
    const isoCut = cutoff.toISOString().slice(0, 10);
    return days.filter(r => r.day_et >= isoCut);
  }

  function trimLeadingZeros(days) {
    // For "All Time", start at first non-zero day (spins OR payouts)
    const idx = days.findIndex(r => coerceNumber(r.spins) > 0 || coerceNumber(r.total_base) > 0);
    return idx <= 0 ? days : days.slice(idx);
  }

  function buildDatasets(days, decimals) {
    const labels = days.map(r => r.day_et);
    const spins = days.map(r => coerceNumber(r.spins));
    const payouts = days.map(r => {
      const base = coerceNumber(r.total_base);
      const dec = Number.isFinite(Number(decimals)) ? Number(decimals) : 5;
      return base / Math.pow(10, dec);
    });

    return { labels, spins, payouts };
  }

  function makeChart({ labels, spins, payouts }) {
    if (chart) chart.destroy();

    const ctx = canvas.getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Spins',
            data: spins,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            yAxisID: 'ySpins'
          },
          {
            label: 'Payouts',
            data: payouts,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            yAxisID: 'yPayouts'
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const dsLabel = ctx.dataset.label || '';
                const val = ctx.parsed.y;
                if (dsLabel === 'Payouts') {
                  // show up to 6 decimals but trim trailing zeros
                  return `${dsLabel}: ${Number(val).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
                }
                return `${dsLabel}: ${val}`;
              }
            }
          }
        },
        scales: {
          ySpins: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            ticks: { precision: 0 }
          },
          yPayouts: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false }
          },
          x: {
            ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }
          }
        }
      }
    });
  }

  function render(range = 'all') {
    const chosen = range === 'all' ? trimLeadingZeros(fullDays) : filterByRange(fullDays, range);
    const decimals = window.__wheel_decimals ?? 5;
    const ds = buildDatasets(chosen, decimals);
    makeChart(ds);
  }

  async function init() {
    try {
      if (!SERVER_ID || !CONTRACT) {
        console.warn('chart.js: missing server_id or contract_address in URL');
      }
      const { days, decimals } = await fetchWithFallback();

      // Validate / sanitize rows
      fullDays = (days || []).filter(isValidDayRow).map(r => ({
        day_et: r.day_et,
        spins: coerceNumber(r.spins, 0),
        total_base: coerceNumber(r.total_base, 0)
      }));

      // cache decimals globally for tooltip formatting
      window.__wheel_decimals = Number.isFinite(Number(decimals)) ? Number(decimals) : 5;

      // Default selection from any dropdown, else All
      const initialRange = (rangeSel && rangeSel.value) ? rangeSel.value : 'all';
      render(initialRange);

      if (rangeSel) {
        rangeSel.addEventListener('change', () => render(rangeSel.value));
      }
    } catch (err) {
      console.error('chart.js init error:', err);
      // draw a tiny empty chart to avoid broken UI
      fullDays = [];
      makeChart({ labels: [], spins: [], payouts: [] });
    }
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();

})();
