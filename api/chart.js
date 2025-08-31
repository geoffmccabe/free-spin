import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, server_id, range = 'past30', contract_address } = req.body;

    if (!token || !server_id) {
      return res.status(400).json({ error: 'Token and server ID required' });
    }
    if (!contract_address) {
      return res.status(400).json({ error: 'contract_address (mint) is required' });
    }

    // Validate token => get discord_id
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });

    // Check admin or superadmin on this server
    const { data: adminData } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tokenData.discord_id)
      .eq('server_id', server_id)
      .single();
    const role = adminData?.role;
    if (role !== 'admin' && role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Query spins for this mint + range
    let query = supabase
      .from('daily_spins')
      .select('created_at, reward, contract_address')
      .eq('contract_address', contract_address);

    if (range === 'past30') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('created_at', thirtyDaysAgo);
    } else if (typeof range === 'object' && range?.start && range?.end) {
      query = query.gte('created_at', range.start).lte('created_at', range.end);
    } // 'all' => no extra filter

    const { data: spins, error } = await query;
    if (error) throw new Error('DB error fetching spins');

    // Aggregate per day: raw values (no normalization)
    const aggregated = (spins || []).reduce((acc, spin) => {
      const date = spin.created_at.split('T')[0];
      if (!acc[date]) acc[date] = { spins: 0, payout: 0 };
      acc[date].spins += 1;
      acc[date].payout += Number(spin.reward || 0);
      return acc;
    }, {});

    const dates = Object.keys(aggregated).sort();
    const spinsData = dates.map(d => aggregated[d].spins);
    const payoutData = dates.map(d => aggregated[d].payout);

    const chartData = {
      labels: dates,
      datasets: [
        { label: '# of Spins', data: spinsData, yAxisID: 'y', tension: 0.2 },
        { label: 'Payout Amount', data: payoutData, yAxisID: 'y1', tension: 0.2 }
      ]
    };

    const options = {
      scales: {
        y:  { type: 'linear', position: 'left',  title: { display: true, text: '# Spins' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: 'Payout Amount' }, grid: { drawOnChartArea: false } }
      }
    };

    return res.status(200).json({ chartData, options });
  } catch (err) {
    console.error('API error:', err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
