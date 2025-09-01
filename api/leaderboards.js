import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function displayNameFor(id, map) {
  const rec = map.get(id);
  return rec?.display_name || rec?.username || rec?.name || id; // fallback to ID if unknown
}

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  try{
    const { token, server_id } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error:'token and server_id required' });

    // Validate token
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    // Tokens allowed for this server
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const mints = (st||[]).map(r=>r.contract_address);
    if (!mints.length) return res.status(200).json({ bySpins:[], byPayout:[] });

    // Fetch spins for these tokens (all-time leaderboards)
    const { data: spins, error: spErr } = await supabase
      .from('daily_spins')
      .select('discord_id,reward,contract_address')
      .in('contract_address', mints);
    if (spErr) return res.status(400).json({ error: spErr.message });

    // Aggregate per user
    const agg = new Map(); // id -> { spins, payout }
    (spins||[]).forEach(row=>{
      const id = row.discord_id;
      if (!agg.has(id)) agg.set(id, { spins: 0, payout: 0 });
      const o = agg.get(id);
      o.spins += 1;
      o.payout += Number(row.reward || 0);
    });

    // Top 200 by spins and by payout
    const all = Array.from(agg.entries()).map(([id, v]) => ({ id, ...v }));
    const bySpins  = all.slice().sort((a,b)=> b.spins - a.spins || b.payout - a.payout).slice(0,200);
    const byPayout = all.slice().sort((a,b)=> b.payout - a.payout || b.spins - a.spins).slice(0,200);

    // Try to resolve Discord usernames from likely tables
    const ids = all.map(r=>r.id);
    const nameMap = new Map();
    // Try discord_users (preferred)
    let { data: d1 } = await supabase.from('discord_users').select('discord_id,username,display_name').in('discord_id', ids);
    if (Array.isArray(d1)) d1.forEach(r=> nameMap.set(r.discord_id, r));
    // Fallback: users table may also carry names
    if (nameMap.size < ids.length) {
      let { data: d2 } = await supabase.from('users').select('discord_id,username,display_name,name').in('discord_id', ids);
      if (Array.isArray(d2)) d2.forEach(r=> { if (!nameMap.has(r.discord_id)) nameMap.set(r.discord_id, r); });
    }

    const shapedSpins = bySpins.map((r,i)=> ({
      rank: i+1, user: displayNameFor(r.id, nameMap), spins: r.spins, payout: r.payout
    }));
    const shapedPayout = byPayout.map((r,i)=> ({
      rank: i+1, user: displayNameFor(r.id, nameMap), spins: r.spins, payout: r.payout
    }));

    return res.status(200).json({ bySpins: shapedSpins, byPayout: shapedPayout });
  }catch(e){
    console.error('leaderboards error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
