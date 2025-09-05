import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SECRET = process.env.SPIN_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- Eastern (US) day bucketing ----------
const NY_TZ = 'America/New_York';

function nyDateKey(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  let y = '', m = '', day = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${y}-${m}-${day}`;
}
function addDaysUTC(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function buildNYDayKeys(backDays, nowUTC) {
  const seen = new Set();
  const keys = [];
  for (let i = backDays; i >= 0; i--) {
    const k = nyDateKey(addDaysUTC(nowUTC, -i));
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

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

    const nowUTC = new Date();

    // Fetch a wide enough UTC window; we’ll bucket by NY day after.
    const fetchBackDays = range === 'all' ? 3660 : 120;
    const startISO = addDaysUTC(nowUTC, -fetchBackDays).toISOString();
    const endISO   = nowUTC.toISOString();

    // Pull rows (prefer created_at_utc; include legacy created_at).
    const cols = 'created_at_utc, created_at, server_id, contract_address, reward';
    let { data: r1, error: e1 } = await supabase
      .from('daily_spins')
      .select(cols)
      .eq('server_id', server_id)
      .gte('created_at_utc', startISO)
      .lte('created_at_utc', endISO)
      .order('created_at_utc', { ascending: true });
    if (e1) throw new Error(e1.message);
    r1 = r1 || [];

    let { data: r2, error: e2 } = await supabase
      .from('daily_spins')
      .select(cols)
      .eq('server_id', server_id)
      .is('created_at_utc', null)
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .order('created_at', { ascending: true });
    if (e2) throw new Error(e2.message);
    r2 = r2 || [];

    const all = [...r1, ...r2];

    // Find the earliest timestamp where ANY row has a non-null contract_address for this server.
    // Any rows *before* this point with NULL contract_address are treated as the single legacy token.
    let earliestNonNullMintTime = null;
    for (const r of all) {
      if (r.contract_address) {
        const t = new Date(r.created_at_utc || r.created_at);
        if (!earliestNonNullMintTime || t < earliestNonNullMintTime) earliestNonNullMintTime = t;
      }
    }

    // Build NY labels
    const labels = (range === 'all')
      ? (() => {
          if (all.length === 0) return buildNYDayKeys(30, nowUTC);
          let earliest = all[0];
          for (const r of all) {
            const a = r.created_at_utc || r.created_at;
            const b = earliest.created_at_utc || earliest.created_at;
            if (a && b && new Date(a) < new Date(b)) earliest = r;
          }
          const firstKey = nyDateKey(new Date(earliest.created_at_utc || earliest.created_at));
          const huge = buildNYDayKeys(3660, nowUTC);
          const startIdx = Math.max(0, huge.indexOf(firstKey));
          return huge.slice(startIdx);
        })()
      : buildNYDayKeys(30, nowUTC);

    const idx = new Map(labels.map((k, i) => [k, i]));
    const spins = new Array(labels.length).fill(0);
    const payout = new Array(labels.length).fill(0);

    for (const r of all) {
      const whenRaw = r.created_at_utc || r.created_at;
      if (!whenRaw) continue;
      const when = new Date(whenRaw);
      const key = nyDateKey(when);
      const i = idx.get(key);
      if (i === undefined) continue;

      // Should this row count for the selected token?
      const tokenSelected = Boolean(contract_address);
      let isThisToken = true;

      if (tokenSelected) {
        isThisToken =
          (r.contract_address === contract_address) ||
          (
            !r.contract_address &&
            earliestNonNullMintTime && when < earliestNonNullMintTime
          ); // legacy Harold-only days: treat NULL mint as the selected token
      }

      // Spins: server-wide if no token chosen; otherwise token-scoped
      if (!tokenSelected) {
        spins[i] += 1;
      } else if (isThisToken) {
        spins[i] += 1;
      }

      // Payout: only for a token view, never mix tokens
      if (tokenSelected && isThisToken) {
        const val = Number(r.reward || 0); // reward is stored in display units in your table
        if (!Number.isNaN(val)) payout[i] += val;
      }
    }

    const datasets = [{ label: 'Spins', data: spins, yAxisID: 'y', tension: 0.25 }];
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
