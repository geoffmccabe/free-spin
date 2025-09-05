import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN_SECRET = process.env.SPIN_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

async function getDecimals(contract_address) {
  if (!contract_address) return 0;
  const { data, error } = await supabase
    .from('token_metadata')
    .select('decimals')
    .eq('contract_address', contract_address)
    .single();
  if (error || !data) return 5;
  return Number(data.decimals || 5);
}

async function fetchAllDailySpins({ server_id, contract_address }) {
  let query = supabase.from('daily_spins')
    .select('discord_id, amount_base, contract_address', { count: 'exact' });

  if (server_id) query = query.eq('server_id', server_id);
  if (contract_address) query = query.eq('contract_address', contract_address);

  const pageSize = 5000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await query
      .order('created_at_utc', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`DB error: ${error.message}`);
    if (!data || data.length === 0) break;

    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchDiscordNames(discordIds) {
  if (discordIds.length === 0) return new Map();
  const chunkSize = 500;
  const map = new Map();
  for (let i = 0; i < discordIds.length; i += chunkSize) {
    const chunk = discordIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('discord_users')
      .select('discord_id, username, display_name, global_name, nick, nickname, name, handle, discord_tag')
      .in('discord_id', chunk);
    if (error) continue;
    for (const row of data || []) {
      const best =
        row.global_name ||
        row.display_name ||
        row.username ||
        row.nick ||
        row.nickname ||
        row.name ||
        row.handle ||
        row.discord_tag ||
        row.discord_id;
      map.set(row.discord_id, String(best));
    }
  }
  return map;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token: signedToken, server_id, contract_address, sort = 'spins', limit = 200 } = req.body || {};

    if (!verifySignedToken(signedToken)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!server_id) {
      return res.status(400).json({ error: 'server_id required' });
    }

    // Pull all rows (token-scoped or server-wide)
    const rows = await fetchAllDailySpins({ server_id, contract_address });

    // Aggregate
    const agg = new Map(); // discord_id -> { spins, payoutBase }
    for (const r of rows) {
      const id = r.discord_id;
      if (!agg.has(id)) agg.set(id, { spins: 0, payoutBase: 0n });
      const a = agg.get(id);
      a.spins += 1;
      if (contract_address) {
        a.payoutBase += BigInt(r.amount_base ?? 0);
      }
    }

    // Resolve names
    const ids = Array.from(agg.keys());
    const nameMap = await fetchDiscordNames(ids);

    // Convert to array and sort
    let arr = ids.map(id => {
      const { spins, payoutBase } = agg.get(id);
      return { discord_id: id, spins, payoutBase };
    });

    if (sort === 'payout' && contract_address) {
      arr.sort((a, b) => (b.payoutBase > a.payoutBase ? 1 : b.payoutBase < a.payoutBase ? -1 : 0));
    } else {
      arr.sort((a, b) => b.spins - a.spins);
    }

    // Trim to requested limit
    arr = arr.slice(0, Math.max(1, Math.min(Number(limit) || 200, 1000)));

    // Attach display fields
    const decimals = await getDecimals(contract_address);
    const denom = decimals ? (BigInt(10) ** BigInt(decimals)) : 1n;

    const leaderboard = arr.map(row => ({
      discord_id: row.discord_id,
      user: nameMap.get(row.discord_id) || row.discord_id,
      spins: row.spins,
      ...(contract_address ? { payout: Number(row.payoutBase) / Number(denom) } : {})
    }));

    return res.status(200).json({ leaderboard, mode: contract_address ? 'token' : 'server' });
  } catch (err) {
    console.error('adminleaderboards api error:', err);
    return res.status(500).json({ error: 'Admin leaderboard API error' });
  }
}
