import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SECRET = process.env.SPIN_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

function pickName(row) {
  return (
    row.display_name ||
    row.global_name ||
    row.nickname ||
    row.nick ||
    row.username ||
    row.discord_tag ||
    row.name ||
    row.handle ||
    row.discord_id
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token: signedToken, server_id, contract_address, sort_by } = req.body || {};
    if (!verifySignedToken(signedToken)) return res.status(403).json({ error: 'Unauthorized' });
    if (!server_id) return res.status(400).json({ error: 'server_id required' });

    // If caller didn't pass a token, but the server only has ONE enabled token, use it.
    let tokenToUse = contract_address || null;
    if (!tokenToUse) {
      const { data: enabled, error: enErr } = await supabase
        .from('server_tokens')
        .select('contract_address, enabled')
        .eq('server_id', server_id)
        .eq('enabled', true);
      if (enErr) throw new Error(enErr.message);
      if ((enabled || []).length === 1) tokenToUse = enabled[0].contract_address;
    }

    // Pull spins for this server (optionally token-scoped)
    const cols = 'discord_id, reward, contract_address';
    let q = supabase.from('daily_spins').select(cols).eq('server_id', server_id);
    if (tokenToUse) q = q.eq('contract_address', tokenToUse);
    const { data: spins, error } = await q.limit(100000);
    if (error) throw new Error(error.message);

    const byUser = new Map(); // discord_id -> {spins, payout}
    for (const r of (spins || [])) {
      const id = r.discord_id || 'unknown';
      if (!byUser.has(id)) byUser.set(id, { spins: 0, payout: 0 });
      const cur = byUser.get(id);
      cur.spins += 1;
      if (tokenToUse) {
        const v = Number(r.reward || 0);
        if (!Number.isNaN(v)) cur.payout += v;
      }
    }

    // Resolve names
    const ids = Array.from(byUser.keys()).filter(x => x && x !== 'unknown');
    let nameRows = [];
    if (ids.length) {
      const { data: names, error: nerr } = await supabase
        .from('discord_users')
        .select('discord_id, username, display_name, global_name, nick, nickname, name, handle, discord_tag')
        .in('discord_id', ids);
      if (nerr) throw new Error(nerr.message);
      nameRows = names || [];
    }
    const nameMap = new Map(nameRows.map(r => [r.discord_id, pickName(r)]));

    let rows = Array.from(byUser.entries()).map(([discord_id, agg]) => ({
      discord_id,
      user: nameMap.get(discord_id) || discord_id,
      spins: agg.spins,
      payout: Math.round(agg.payout)
    }));

    const sortKey =
      (String(sort_by || 'spins').toLowerCase() === 'payout' && tokenToUse)
        ? 'payout'
        : 'spins';

    rows.sort((a, b) => b[sortKey] - a[sortKey]);
    rows = rows.slice(0, 200);

    return res.status(200).json({ rows, sortKey, tokenScoped: Boolean(tokenToUse) });
  } catch (err) {
    console.error('adminleaderboards error:', err);
    return res.status(500).json({ error: 'Admin leaderboards API error' });
  }
}
