import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function rangeToStart(range) {
  const now = Date.now();
  if (range === '7d') return new Date(now - 6 * 24 * 3600 * 1000);
  if (range === '30d') return new Date(now - 29 * 24 * 3600 * 1000);
  if (range === '90d') return new Date(now - 89 * 24 * 3600 * 1000);
  if (range === 'all') return new Date('2024-01-01T00:00:00Z');
  return new Date(now - 29 * 24 * 3600 * 1000); // default 30d
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { server_id, contract_address, view = 'token', range = '30d', sort = 'spins' } = req.body || {};
    if (!server_id) return res.status(400).json({ error: 'server_id required' });
    if (view === 'token' && !contract_address) return res.status(400).json({ error: 'contract_address required' });

    const start = rangeToStart(range);
    const end = new Date();

    let q = supabase
      .from('daily_spins')
      .select('discord_id, payout_amount_raw, contract_address, created_at')
      .eq('server_id', server_id)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString());

    if (view === 'token') q = q.eq('contract_address', contract_address);

    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // decimals: if token-scoped, read from wheel_configurations (scoped by server_id)
    let decimals = 0;
    if (view === 'token') {
      const { data: cfg, error: cfgErr } = await supabase
        .from('wheel_configurations')
        .select('decimals')
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .maybeSingle();

      if (cfgErr) return res.status(500).json({ error: cfgErr.message });
      if (cfg && Number.isFinite(cfg.decimals)) decimals = cfg.decimals;
    }

    // Aggregate by user
    const map = new Map();
    for (const r of rows || []) {
      const key = r.discord_id || 'unknown';
      const obj = map.get(key) || { discord_id: key, spins: 0, payoutBase: 0n };
      obj.spins += 1;

      // payout_amount_raw is numeric in DB; convert safely
      const base = r.payout_amount_raw != null ? BigInt(String(r.payout_amount_raw).split('.')[0]) : 0n;
      obj.payoutBase += base;

      map.set(key, obj);
    }

    let list = Array.from(map.values()).map(v => ({
      discord_id: v.discord_id,
      spins: v.spins,
      payout: Number(v.payoutBase) / (10 ** decimals)
    }));

    list.sort((a, b) => (sort === 'payout' ? (b.payout - a.payout) : (b.spins - a.spins)));
    list = list.slice(0, 200);

    return res.status(200).json({ rows: list });
  } catch (e) {
    console.error('adminleaderboards error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
