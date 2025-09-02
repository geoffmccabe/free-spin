import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use ONLY your existing Vercel var.
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const toId = (v) => (v == null ? '' : String(v));
const bestName = (o) =>
  o?.display_name || o?.global_name || o?.nick || o?.nickname ||
  o?.username || o?.name || o?.handle || o?.discord_tag || null;

async function safeFetch(table, cols, build) {
  try {
    const q = supabase.from(table).select(cols);
    const { data, error } = build ? await build(q) : await q;
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

// Cached name lookup from your DB
async function resolveNamesFromDB(ids, server_id) {
  const nameMap = new Map();
  const sources = [
    ['server_members', 'discord_id,server_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag', (q) => q.eq('server_id', server_id).in('discord_id', ids)],
    ['discord_users',  'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q) => q.in('discord_id', ids)],
    ['users',          'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q) => q.in('discord_id', ids)],
    ['spin_tokens',    'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q) => q.in('discord_id', ids)]
  ];
  for (const [tbl, cols, build] of sources) {
    const rows = await safeFetch(tbl, cols, build);
    for (const r of rows) {
      const id = toId(r.discord_id);
      if (!id || nameMap.has(id)) continue;
      const nm = bestName(r);
      if (nm) nameMap.set(id, nm);
    }
    if (nameMap.size === ids.length) break;
  }
  return nameMap;
}

// Discord API helpers (uses DISCORD_TOKEN)
const authHeader = DISCORD_TOKEN
  ? (DISCORD_TOKEN.startsWith('Bot ')_
