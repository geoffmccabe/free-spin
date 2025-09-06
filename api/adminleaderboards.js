import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DECIMALS = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { server_id, contract_address, sort_by = 'spins' } = req.body || {};
    if (!server_id || !contract_address) {
      return res.status(400).json({ error: 'server_id and contract_address required' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Pull normalized rows for this token only (no mixing)
    const { data: rows, error } = await supabase
      .from('daily_spins')
      .select('discord_id, amount_base')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address);

    if (error) throw error;

    // Aggregate per user
    const denom = Math.pow(10, DECIMALS);
    const agg = new Map(); // discord_id -> { spins, base }
    for (const r of rows || []) {
      const id = r.discord_id || 'unknown';
      const cur = agg.get(id) || { spins: 0, base: 0 };
      cur.spins += 1;
      cur.base += Number(r.amount_base || 0);
      agg.set(id, cur);
    }

    // Resolve human names from cache
    const ids = Array.from(agg.keys()).slice(0, 500);
    const label = new Map();
    if (ids.length) {
      const { data: who } = await supabase
        .from('discord_users')
        .select('discord_id, username, display_name, global_name, nick, nickname, name, handle, discord_tag')
        .in('discord_id', ids);
      for (const w of who || []) {
        label.set(
          w.discord_id,
          w.display_name || w.global_name || w.username || w.nick || w.nickname || w.name || w.handle || w.discord_tag || w.discord_id
        );
      }
    }

    let items = Array.from(agg.entries()).map(([discord_id, v]) => ({
      discord_id,
      user: label.get(discord_id) || discord_id,
      spins: v.spins,
      payout: v.base / denom
    }));

    if (sort_by === 'payout') items.sort((a, b) => b.payout - a.payout || b.spins - a.spins);
    else items.sort((a, b) => b.spins - a.spins || b.payout - a.payout);

    return res.status(200).json({ items: items.slice(0, 200) });
  } catch (e) {
    console.error('adminleaderboards error', e);
    return res.status(500).json({ error: 'Admin leaderboards failed' });
  }
}
