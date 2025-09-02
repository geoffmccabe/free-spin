// Securely upsert Discord usernames so leaderboards show names instead of numeric IDs.
// Call this from your Discord bot with a shared secret.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_BOT_KEY = process.env.ADMIN_BOT_KEY; // set this in Vercel

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = req.headers['x-bot-key'] || req.body?.bot_key;
    if (!ADMIN_BOT_KEY || auth !== ADMIN_BOT_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const users = Array.isArray(req.body?.users) ? req.body.users : [];
    if (!users.length) return res.status(400).json({ error: 'users array required' });

    // Ensure table exists in your DB: discord_users(discord_id PRIMARY KEY, username, display_name, global_name, nick, nickname, name, handle, discord_tag)
    const rows = users.map(u => ({
      discord_id: String(u.discord_id),
      username: u.username ?? null,
      display_name: u.display_name ?? null,
      global_name: u.global_name ?? null,
      nick: u.nick ?? null,
      nickname: u.nickname ?? null,
      name: u.name ?? null,
      handle: u.handle ?? null,
      discord_tag: u.discord_tag ?? null,
    }));

    const { error } = await supabase
      .from('discord_users')
      .upsert(rows, { onConflict: 'discord_id' });

    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true, upserted: rows.length });
  } catch (e) {
    console.error('discord-upsert-users error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
