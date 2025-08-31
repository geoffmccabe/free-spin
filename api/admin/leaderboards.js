import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Validate token => discord_id
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });

    // Must be admin/superadmin
    const { data: adminData } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tokenData.discord_id)
      .eq('server_id', server_id)
      .single();
    const role = adminData?.role;
    if (role !== 'admin' && role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' });

    // Aggregate daily_spins (all time); if you want a window add a gte('created_at', ...)
    const { data: spins, error } = await supabase
      .from('daily_spins')
      .select('discord_id, reward');
    if (error) throw error;

    // Group
    const agg = {};
    for (const row of (spins || [])) {
      const id = row.discord_id;
      if (!agg[id]) agg[id] = { spins: 0, payout: 0 };
      agg[id].spins += 1;
      agg[id].payout += Number(row.reward || 0);
    }

    // Build arrays
    const all = Object.entries(agg).map(([discord_id, v]) => ({ discord_id, spins: v.spins, payout: v.payout }));
    const bySpins = all.slice().sort((a, b) => b.spins - a.spins).slice(0, 200);
    const byPayout = all.slice().sort((a, b) => b.payout - a.payout).slice(0, 200);

    // Fetch optional usernames (if your `users` table has them)
    const ids = Array.from(new Set([...bySpins, ...byPayout].map(x => x.discord_id)));
    let nameMap = {};
    if (ids.length) {
      const { data: users } = await supabase
        .from('users')
        .select('discord_id, username')
        .in('discord_id', ids);
      for (const u of (users || [])) {
        nameMap[u.discord_id] = u.username || u.discord_id;
      }
    }

    const label = (id) => nameMap[id] || id;

    return res.status(200).json({
      bySpins: bySpins.map((x, i) => ({ rank: i + 1, user: label(x.discord_id), spins: x.spins, payout: x.payout })),
      byPayout: byPayout.map((x, i) => ({ rank: i + 1, user: label(x.discord_id), spins: x.spins, payout: x.payout }))
    });
  } catch (e) {
    console.error('leaderboards error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
