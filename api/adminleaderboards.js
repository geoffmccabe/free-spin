import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { server_id, contract_address, view='token', range='30d', sort='spins' } = req.body || {};
    if (!server_id) return res.status(400).json({ error: 'server_id required' });
    if (view === 'token' && !contract_address) return res.status(400).json({ error: 'contract_address required' });

    const end = new Date();
    const start = range === 'all' ? new Date('2024-01-01T00:00:00Z') : new Date(Date.now() - 29 * 24 * 3600 * 1000);

    let sel = supabase.from('daily_spins')
      .select('discord_id, amount_base, contract_address, created_at_utc')
      .eq('server_id', server_id)
      .gte('created_at_utc', start.toISOString())
      .lte('created_at_utc', end.toISOString());

    if (view === 'token') sel = sel.eq('contract_address', contract_address);

    const { data: rows, error } = await sel;
    if (error) return res.status(500).json({ error: error.message });

    // token decimals if token-scoped (default 5)
    let decimals = 5;
    if (view === 'token') {
      const { data: cfg } = await supabase.from('wheel_configurations')
        .select('decimals').eq('contract_address', contract_address).maybeSingle();
      if (cfg && typeof cfg.decimals === 'number') decimals = cfg.decimals;
    }

    // Aggregate by user
    const map = new Map();
    for (const r of rows || []) {
      const key = r.discord_id || 'unknown';
      const obj = map.get(key) || { discord_id: key, spins:0, payoutBase:0n };
      obj.spins += 1;
      if (typeof r.amount_base === 'number') obj.payoutBase += BigInt(r.amount_base);
      map.set(key, obj);
    }

    let list = Array.from(map.values()).map(v => ({
      discord_id: v.discord_id,
      spins: v.spins,
      payout: Number(v.payoutBase) / 10 ** decimals
    }));

    // Attach names from discord_users table if present
    if (list.length) {
      const ids = list.map(x => x.discord_id);
      const { data: names } = await supabase.from('discord_users')
        .select('discord_id, username, display_name, global_name, nick, nickname, name, handle, discord_tag')
        .in('discord_id', ids);
      const nameMap = new Map((names||[]).map(n => [n.discord_id, n]));
      list = list.map(x => {
        const n = nameMap.get(x.discord_id);
        const best = n?.display_name || n?.global_name || n?.username || n?.discord_tag || n?.name || n?.handle || n?.nick || n?.nickname;
        return { ...x, name: best || x.discord_id };
      });
    }

    list.sort((a,b) => sort==='payout' ? (b.payout - a.payout) : (b.spins - a.spins));
    list = list.slice(0, 200);

    return res.status(200).json({ rows: list });
  } catch (e) {
    console.error('adminleaderboards error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
