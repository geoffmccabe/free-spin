import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // must be set; no fallback

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

async function resolveNamesFromDB(ids, server_id) {
  const nameMap = new Map();
  const sources = [
    ['server_members','discord_id,server_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',(q)=>q.eq('server_id',server_id).in('discord_id',ids)],
    ['discord_users', 'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q)=>q.in('discord_id',ids)],
    ['users',         'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q)=>q.in('discord_id',ids)],
    ['spin_tokens',   'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag',         (q)=>q.in('discord_id',ids)],
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

// ---- Discord lookup (never throws) ----
const authHeader = DISCORD_TOKEN
  ? (DISCORD_TOKEN.startsWith('Bot ') || DISCORD_TOKEN.startsWith('Bearer ')
      ? DISCORD_TOKEN
      : `Bot ${DISCORD_TOKEN}`)
  : null;

async function fetchMemberNameFromDiscord(server_id, user_id) {
  if (!authHeader) return null;
  const headers = { Authorization: authHeader };
  try {
    // guild member (needs Server Members Intent for nick)
    const r1 = await fetch(`https://discord.com/api/v10/guilds/${server_id}/members/${user_id}`, { headers });
    if (r1.ok) {
      const j = await r1.json().catch(()=>null);
      if (j) return j.nick || j.user?.global_name || j.user?.username || null;
    }
  } catch {}
  try {
    // global user
    const r2 = await fetch(`https://discord.com/api/v10/users/${user_id}`, { headers });
    if (r2.ok) {
      const j = await r2.json().catch(()=>null);
      if (j) return j.global_name || j.username || null;
    }
  } catch {}
  return null;
}

async function upsertNamesCache(pairs) {
  if (!pairs?.length) return;
  const rows = pairs.map(p => ({
    discord_id: String(p.discord_id),
    username: p.name,
    display_name: p.name,
    global_name: p.name,
  }));
  try {
    await supabase.from('discord_users').upsert(rows, { onConflict: 'discord_id' });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // validate token
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // server mints (enabled+disabled)
    const st = await safeFetch('server_tokens', 'contract_address', q => q.eq('server_id', server_id));
    const mints = (st || []).map(r => r.contract_address).filter(Boolean);
    if (!mints.length) return res.status(200).json({ bySpins: [], byPayout: [] });

    // collect spins from current + legacy
    const cur  = await safeFetch('daily_spins', 'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const leg1 = await safeFetch('spins',       'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const leg2 = await safeFetch('wheel_spins', 'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const spins = cur.concat(leg1, leg2);

    // aggregate
    const agg = new Map();
    for (const r of spins) {
      const id = toId(r.discord_id);
      if (!id) continue;
      const v = agg.get(id) || { spins: 0, payout: 0 };
      v.spins += 1;
      v.payout += Number(r.reward || 0);
      agg.set(id, v);
    }
    const all = Array.from(agg.entries()).map(([id, v]) => ({ id, ...v }));
    const bySpins  = all.slice().sort((a,b)=> b.spins  - a.spins  || b.payout - a.payout).slice(0,200);
    const byPayout = all.slice().sort((a,b)=> b.payout - a.payout || b.spins  - a.spins ).slice(0,200);

    // names from DB cache first
    const ids = all.map(r => r.id);
    const nameMap = await resolveNamesFromDB(ids, server_id);

    // fill gaps via Discord (NEVER fail the request)
    const missing = ids.filter(id => !nameMap.has(id));
    if (missing.length && authHeader) {
      const limit = 4; // polite to Discord
      const queue = [...missing];
      const results = [];
      const runners = Array.from({ length: Math.min(limit, queue.length) }, async function run() {
        while (queue.length) {
          const id = queue.shift();
          const nm = await fetchMemberNameFromDiscord(server_id, id);
          if (nm) results.push({ discord_id: id, name: nm });
        }
      });
      await Promise.all(runners);
      if (results.length) {
        for (const r of results) nameMap.set(r.discord_id, r.name);
        await upsertNamesCache(results);
      }
    }

    const shape = (arr) => arr.map((r,i)=> ({
      rank: i+1,
      user: nameMap.get(r.id) || r.id,
      spins: r.spins,
      payout: r.payout
    }));

    return res.status(200).json({
      bySpins:  shape(bySpins),
      byPayout: shape(byPayout)
    });
  } catch (e) {
    console.error('adminleaderboards fatal:', e);
    // ALWAYS return JSON so the front-end never chokes on text/HTML
    return res.status(200).json({ bySpins: [], byPayout: [], error: 'leaderboard_error' });
  }
}
