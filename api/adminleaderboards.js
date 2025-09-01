import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function pickName(rec = {}) {
  return (
    rec.display_name ||
    rec.global_name ||
    rec.username ||
    rec.discord_username ||
    rec.name ||
    rec.handle ||
    null
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { token, server_id } = (req.body || {});
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Validate token
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    // Which tokens count
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const mints = (st || []).map(r => r.contract_address);
    if (!mints.length) return res.status(200).json({ bySpins: [], byPayout: [] });

    // Spins (all-time)
    const { data: spins, error: spErr } = await supabase
      .from('daily_spins')
      .select('discord_id,reward,contract_address')
      .in('contract_address', mints);
    if (spErr) return res.status(400).json({ error: spErr.message });

    // Aggregate
    const agg = new Map();
    for (const row of (spins || [])) {
      const id = row.discord_id;
      if (!agg.has(id)) agg.set(id, { spins: 0, payout: 0 });
      const a = agg.get(id);
      a.spins += 1;
      a.payout += Number(row.reward || 0);
    }
    const all = Array.from(agg.entries()).map(([id, v]) => ({ id, ...v }));
    const bySpins  = all.slice().sort((a,b)=> b.spins - a.spins || b.payout - a.payout).slice(0,200);
    const byPayout = all.slice().sort((a,b)=> b.payout - a.payout || b.spins - a.spins).slice(0,200);

    // ---- Resolve Discord usernames (multi-table fallback) ----
    const ids = all.map(r => r.id);
    const map = new Map();

    async function tryLoad(table, cols) {
      try {
        const { data, error } = await supabase.from(table).select(cols).in('discord_id', ids);
        if (error || !Array.isArray(data)) return;
        for (const r of data) if (!map.has(r.discord_id)) map.set(r.discord_id, r);
      } catch {}
    }

    // Preferred sources (add more if you keep names elsewhere)
    await tryLoad('discord_users',     'discord_id,username,display_name,global_name');
    await tryLoad('users',             'discord_id,username,display_name,name,discord_username');
    await tryLoad('discord_profiles',  'discord_id,username,display_name,global_name');

    const toRow = (r, i) => ({
      rank: i+1,
      user: pickName(map.get(r.id)) || r.id, // fall back to id if no name known (see note below to ingest names)
      spins: r.spins,
      payout: r.payout
    });

    return res.status(200).json({
      bySpins:  bySpins.map((r,i)=> toRow(r,i)),
      byPayout: byPayout.map((r,i)=> toRow(r,i)),
    });
  } catch (e) {
    console.error('adminleaderboards error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
