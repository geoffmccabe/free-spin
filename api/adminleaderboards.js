import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../lib/auth.js';
import { selectAllRows } from '../lib/fetchAll.js';

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
    const { token, server_id, contract_address, view = 'token', range = '30d', sort = 'spins' } = req.body || {};
    if (!server_id) return res.status(400).json({ error: 'server_id required' });
    if (view === 'token' && !contract_address) return res.status(400).json({ error: 'contract_address required' });

    const gate = await requireAdmin(supabase, token, server_id);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

    const start = rangeToStart(range);
    const end = new Date();

    // Paged: a plain .select() stops at Supabase's 1000-row cap, which silently
    // built the Top-200 table from only the first 1000 spins in the range.
    const { data: rows, error, truncated } = await selectAllRows(() => {
      let q = supabase
        .from('daily_spins')
        .select('discord_id, payout_amount_raw, contract_address, created_at')
        .eq('server_id', server_id)
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .order('created_at', { ascending: true })
        .order('discord_id', { ascending: true });
      if (view === 'token') q = q.eq('contract_address', contract_address);
      return q;
    });
    if (error) return res.status(500).json({ error: error.message });

    // decimals: if token-scoped, read from wheel_configurations (scoped by server_id).
    // Coerce with Number() — a numeric column can arrive as a string, and the old
    // bare Number.isFinite(cfg.decimals) then left decimals at 0, inflating every
    // payout on this page by 10^decimals versus what the bot's /leaders showed.
    let decimals = 0;
    if (view === 'token') {
      const { data: cfg, error: cfgErr } = await supabase
        .from('wheel_configurations')
        .select('decimals')
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .maybeSingle();

      if (cfgErr) return res.status(500).json({ error: cfgErr.message });
      if (cfg && Number.isFinite(Number(cfg.decimals))) decimals = Number(cfg.decimals);
    }

    // In "All tokens" view the rows span several mints. The old code summed raw base
    // units across all of them with decimals fixed at 0, so a 6-decimal and a
    // 9-decimal token were added together as integers — the payout column was
    // meaningless. Scale each row by its own token's decimals instead.
    const decimalsByMint = new Map();
    if (view === 'token') {
      decimalsByMint.set(contract_address, decimals);
    } else {
      const { data: cfgs } = await supabase
        .from('wheel_configurations')
        .select('contract_address, decimals')
        .eq('server_id', server_id);
      for (const c of cfgs || []) {
        const d = Number(c.decimals);
        decimalsByMint.set(c.contract_address, Number.isFinite(d) ? d : 0);
      }
    }

    // Aggregate by user
    const map = new Map();
    for (const r of rows || []) {
      const key = r.discord_id || 'unknown';
      const obj = map.get(key) || { discord_id: key, spins: 0, payout: 0 };
      obj.spins += 1;

      // payout_amount_raw is numeric in DB; convert safely
      const base = r.payout_amount_raw != null ? Number(String(r.payout_amount_raw).split('.')[0]) : 0;
      const dec = decimalsByMint.get(r.contract_address) ?? decimals;
      if (Number.isFinite(base)) obj.payout += base / (10 ** dec);

      map.set(key, obj);
    }

    let list = Array.from(map.values()).map(v => ({
      discord_id: v.discord_id,
      spins: v.spins,
      payout: Number(v.payout.toFixed(6))
    }));

    // Stable ordering: without a tie-break, equal values ordered arbitrarily.
    list.sort((a, b) =>
      (sort === 'payout' ? (b.payout - a.payout) || (b.spins - a.spins)
                         : (b.spins - a.spins) || (b.payout - a.payout))
      || String(a.discord_id).localeCompare(String(b.discord_id))
    );
    list = list.slice(0, 200);

    // Resolve Discord usernames. The panel has always rendered `r.name || r.discord_id`
    // but nothing ever returned `name`, so the table only ever showed numeric IDs.
    try {
      const ids = list.map(r => r.discord_id).filter(id => id && id !== 'unknown');
      if (ids.length) {
        const { data: users } = await supabase
          .from('discord_users')
          .select('discord_id, username, display_name, global_name')
          .in('discord_id', ids);
        const nameById = new Map(
          (users || []).map(u => [String(u.discord_id), u.display_name || u.global_name || u.username])
        );
        for (const r of list) {
          const n = nameById.get(String(r.discord_id));
          if (n) r.name = n;
        }
      }
    } catch {
      // discord_users is optional — fall back to showing IDs.
    }

    return res.status(200).json({ rows: list, truncated: !!truncated });
  } catch (e) {
    console.error('adminleaderboards error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
