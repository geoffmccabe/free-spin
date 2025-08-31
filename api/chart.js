import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, server_id, range } = req.body;
    if (!token || !server_id) {
      return res.status(400).json({ error: 'Token and server ID required' });
    }

    // Validate token and admin
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();

    if (tokenError || !tokenData) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const { data: adminData, error: adminError } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tokenData.discord_id)
      .eq('server_id', server_id)
      .single();

    if (adminError || adminData?.role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    let query = supabase
      .from('daily_spins')
      .select('created_at, reward', { count: 'exact' });

    if (range === 'past30') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('created_at', thirtyDaysAgo);
    } else if (range.start && range.end) {
      query = query.gte('created_at', range.start).lte('created_at', range.end);
    } // 'all' uses no filter

    const { data: spins, error } = await query;

    if (error) {
      throw new Error('DB error fetching spins');
    }

    // Aggregate by date
    const aggregated = spins.reduce((acc, spin) => {
      const date = spin.created_at.split('T')[0];
      if (!acc[date]) {
        acc[date] = { spins: 0, payout: 0 };
      }
      acc[date].spins += 1;
      acc[date].payout += spin.reward;
      return acc;
    }, {});

    const dates = Object.keys(aggregated).sort();
    const spinsData = dates.map(date => aggregated[date].spins);
    const payoutData = dates.map(date => aggregated[date].payout);

    // Normalize
    const maxSpins = Math.max(...spinsData);
    const maxPayout = Math.max(...payoutData);
    const normalizedSpins = spinsData.map(v => (v / maxSpins) * 100);
    const normalizedPayout = payoutData.map(v => (v / maxPayout) * 100);

    const chartData = {
      labels: dates,
      datasets: [
        { label: '# of Spins', data: normalizedSpins, yAxisID: 'y', borderColor: 'rgb(75, 192, 192)', tension: 0.1 },
        { label: 'Payout Amt', data: normalizedPayout, yAxisID: 'y1', borderColor: 'rgb(255, 99, 132)', tension: 0.1 }
      ]
    };

    const options = {
      scales: {
        y: { type: 'linear', position: 'left', title: { display: true, text: '# Spins (Normalized)' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'Payout Amt (Normalized)' }, grid: { drawOnChartArea: false } }
      }
    };

    return res.status(200).json({ chartData, options });
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
