import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SECRET = process.env.SPIN_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/** Lightweight HMAC check so admin/chart calls don't get blocked by "used" state */
function verifySignedToken(signedToken) {
  try {
    if (!TOKEN_SECRET) return false;
    if (!signedToken || typeof signedToken !== 'string') return false;
    const [token, signature] = signedToken.split('.');
    if (!token || !signature) return false;
    const expected = createHmac('sha256', TOKEN_SECRET).update(token).digest('hex');
    return signature === expected;
  } catch {
    return false;
  }
}

function toISODateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysUTC(d, n) {
  const d2 = new Date(d.getTime());
  d2.setUTCDate(d2.getUTCDate() + n);
  return d2;
}

async function getTokenDecimals(contract_address) {
  if (!contract_address) return 0; // server-wide spins view
  const { data, error } = await supabase
    .from('token_metadata')
    .select('decimals')
    .eq('contract_address', contract_address)
    .single();
  if (error || !data) return 5; // fallback to your current default
  return Number(data.decimals || 5);
}

async function fetchAllSpins({ server_id, contract_address, startISO, endISO }) {
  // build base query
  let query = supabase.from('daily_spins')
    .select('created_at_utc, amount_base, contract_address', { count: 'exact' })
    .gte('created_at_utc', startISO)
    .lte('created_at_utc', endISO);

  if (server_id) query = query.eq('server_id', server_id);
  if (contract_address) query = query.eq('contract_address', contract_address);

  // page through results (1k per page)
  const pageSize = 1000;
  let from = 0;
  let all = [];
  // we need a stable order so pagination is deterministic
  while (true) {
    const { data, error } = await query
      .order('created_at_utc', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`DB error: ${error.message}`);
    if (!data || data.length === 0) break;

    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token: signedToken, server_id, contract_address, range } = req.body || {};

    if (!verifySignedToken(signedToken)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!server_id) {
      return res.status(400).json({ error: 'server_id required' });
    }

    // Time window
    const now = new Date(); // UTC
    const endISO = now.toISOString();
    let startDate;
    if (range === 'all') {
      // fetch everything; we will not set startDate limit (set to a very early date)
      startDate = new Date('2000-01-01T00:00:00Z');
    } else {
      // default: last 30 days (inclusive)
      const d = addDaysUTC(now, -29);
      startDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
    }
    const startISO = startDate.toISOString();

    // Data fetch
    const rows = await fetchAllSpins({ server_id, contract_address, startISO, endISO });

    // Build day buckets from start to end (UTC days)
    const labels = [];
    const dayIndex = new Map();
    for (let d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())); d <= now; d = addDaysUTC(d, 1)) {
      const label = toISODateUTC(d);
      dayIndex.set(label, labels.length);
      labels.push(label);
    }

    // Aggregation
    const spins = new Array(labels.length).fill(0);
    const payoutsBase = new Array(labels.length).fill(0n);

    for (const r of rows) {
      if (!r.created_at_utc) continue;
      const day = toISODateUTC(new Date(r.created_at_utc));
      const idx = dayIndex.get(day);
      if (idx === undefined) continue;
      spins[idx] += 1;
      if (contract_address) {
        // per-token view: sum payouts
        const base = BigInt(r.amount_base ?? 0);
        payoutsBase[idx] += base;
      }
    }

    // Convert base → display if token view
    let datasets;
    if (contract_address) {
      const decimals = await getTokenDecimals(contract_address);
      const denom = BigInt(10) ** BigInt(decimals);
      const payoutsDisplay = payoutsBase.map(b => Number(b) / Number(denom));

      datasets = [
        {
          label: 'Spins',
          data: spins,
          yAxisID: 'y',
          tension: 0.25,
        },
        {
          label: 'Total Payout',
          data: payoutsDisplay,
          yAxisID: 'y1',
          tension: 0.25,
        }
      ];
    } else {
      datasets = [
        {
          label: 'Spins',
          data: spins,
          yAxisID: 'y',
          tension: 0.25,
        }
      ];
    }

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#ddd' } },
        tooltip: { enabled: true }
      },
      scales: {
        x: { ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        y: { beginAtZero: true, ticks: { color: '#bbb' }, grid: { color: 'rgba(255,255,255,0.06)' }, title: { display: true, text: '# Spins', color: '#bbb' } },
        ...(contract_address ? {
          y1: { position: 'right', beginAtZero: true, ticks: { color: '#bbb' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Total Payout', color: '#bbb' } }
        } : {})
      }
    };

    const chartData = { labels, datasets };
    return res.status(200).json({ chartData, options });
  } catch (err) {
    console.error('chart api error:', err);
    return res.status(500).json({ error: 'Chart API error' });
  }
}
