import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SECRET  = process.env.SPIN_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- TZ helpers (America/New_York) ----------
const NY_TZ = 'America/New_York';

// Return "YYYY-MM-DD" in America/New_York for a given Date (UTC-based)
function nyDateKey(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  let y = '', m = '', day = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${y}-${m}-${day}`; // e.g. 2025-09-05
}

// Add N days in UTC (we only use this to sample a wide window, then bucket in NY)
function addDaysUTC(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Build an ordered, de-duplicated list of NY day keys from (now - backDays) .. now
function buildNYDayKeys(backDays, nowUTC) {
  const seen = new Set();
  const keys = [];
  for (let i = backDays; i >= 0; i--) {
    const k = nyDateKey(addDaysUTC(nowUTC, -i));
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

// ---------- auth helper ----------
function verifySignedToken(signedToken) {
  try {
    if (!TOKEN_SECRET) return false;
    const [token, signature] = String(signedToken || '').split('.');
    if (!token || !signature) return false;
    const expected = createHmac('sha256', TOKEN_SECRET).update(token).digest('hex');
    return signature === expected;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token: signedToken, server_id, contract_address, range } = req.body || {};
    if (!verifySignedToken(signedToken)) return res.status(403).json({ error: 'Unauthorized' });
    if (!server_id) return res.status(400).json({ error: 'server_id required' });

    // -------- time window to fetch (UTC), then bucket by NY day ----------
    const nowUTC = new Date();

    // We fetch a little wider window than we need to avoid edge clipping across timezones.
    // For "past30": fetch last 45 UTC days; for "all": fetch from a safe early anchor.
    const fetchBackDays = range === 'all' ? 3660 /* ~10y safety */ : 45;

    const startUTC = addDaysUTC(nowUTC, -fetchBackDays);
    const startISO = startUTC.toISOString();
    const endISO   = nowUTC.toISOString();

    // Preferred rows with created_at_utc inside the window
    let { data: rows1, error: e1 } = await supabase
      .from('daily_spins')
      .select('created_at_utc, created_at, server_id, contract_address, reward')
      .eq('server_id', server_id)
      .gte('created_at_utc', startISO)
      .lte('created_at_utc', endISO)
      .order('created_at_utc', { ascending: true });
    if (e1) throw new Error(e1.message);
    rows1 = rows1 || [];

    // Legacy rows missing created_at_utc — fall back to created_at
    let rows2 = [];
    {
      const { data: r2, error: e2 } = await supabase
        .from('daily_spins')
        .select('created_at_utc, created_at, server_id, contract_address, reward')
        .eq('server_id', server_id)
        .is('created_at_utc', null)
        .gte('created_at', startISO)
        .lte('created_at', endISO)
        .order('created_at', { ascending: true });
      if (e2) throw new Error(e2.message);
      rows2 = r2 || [];
    }

    const all = [...rows1, ...rows2];

    // -------- build NY-day labels ----------
    // For "all": derive earliest NY day key from data; otherwise use last 30 NY days.
    let labels;
    if (range === 'all') {
      if (all.length === 0) {
        labels = buildNYDayKeys(30, nowUTC); // empty fallback
      } else {
        // find the earliest record, compute its NY key, then walk day-by-day until today
        let earliest = all[0];
        for (const r of all) {
          const a = r.created_at_utc || r.created_at;
          const b = earliest.created_at_utc || earliest.created_at;
          if (a && b && new Date(a) < new Date(b)) earliest = r;
        }
        const firstKey = nyDateKey(new Date(earliest.created_at_utc || earliest.created_at));
        // Generate keys from earliest..today by sampling UTC days and de-duplicating
        // (safe across DST because we always resolve to NY keys)
        const maxBack = 3660; // ~10y cap
        const tmp = buildNYDayKeys(maxBack, nowUTC);
        const startIdx = Math.max(0, tmp.indexOf(firstKey));
        labels = tmp.slice(startIdx);
      }
    } else {
      labels = buildNYDayKeys(30, nowUTC); // past 30 days by NY
    }

    const index = new Map(labels.map((k, i) => [k, i]));
    const spins  = new Array(labels.length).fill(0);
    const payout = new Array(labels.length).fill(0);

    // -------- aggregate into NY day buckets ----------
    for (const r of all) {
      if (contract_address && r.contract_address !== contract_address) continue;

      const when = r.created_at_utc || r.created_at;
      if (!when) continue;
      const key = nyDateKey(new Date(when));
      const i = index.get(key);
      if (i === undefined) continue;

      spins[i] += 1;
      if (contract_address) {
        const val = Number(r.reward || 0);
        if (!Number.isNaN(val)) payout[i] += val; // reward is display units per your current table
      }
    }

    const datasets = [
      { label: 'Spins', data: spins, yAxisID: 'y', tension: 0.25 }
    ];
    if (contract_address) {
      datasets.push({ label: 'Total Payout', data: payout, yAxisID: 'y1', tension: 0.25 });
    }

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#ddd' } }, tooltip: { enabled: true } },
      scales: {
        x:  { ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y:  { beginAtZero: true, ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '# Spins', color: '#bbb' } },
        ...(contract_address ? {
          y1: { position: 'right', beginAtZero: true, ticks: { color: '#bbb' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Total Payout', color: '#bbb' } }
        } : {})
      }
    };

    return res.status(200).json({ chartData: { labels, datasets }, options, timezone: NY_TZ });
  } catch (err) {
    console.error('chart error:', err);
    return res.status(500).json({ error: 'Chart API error' });
  }
}
