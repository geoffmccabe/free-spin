import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function bestName(o){
  return o?.display_name || o?.global_name || o?.username || o?.nick || o?.name || o?.handle || null;
}
function displayNameFor(id, map){ return map.get(id) || id; }

async function safeFetch(table, ids){
  try{
    const { data, error } = await supabase.from(table).select('*').in('discord_id', ids);
    if (error) return [];
    return data || [];
  }catch{ return []; }
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

    // All tokens for this server (enabled or disabled)
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);
    if (stErr) return res.status(400).json({ error: stErr.message });
    const mints = (st||[]).map(r=>r.contract_address);
    if (!mints.length) return res.status(200).json({ bySpins:[], byPayout:[] });

    // Fetch spins across those tokens
    const { data: spins, error: spErr } = await supabase
      .from('daily_spins')
      .select('discord_id,reward,contract_address')
      .in('contract_address', mints);
    if (spErr) return res.status(400).json({ error: spErr.message });

    // Aggregate per user
    const agg = new Map();
    (spins||[]).forEach(row=>{
      const id = String(row.discord_id);
      if (!agg.has(id)) agg.set(id, { spins:0, payout:0 });
      const o = agg.get(id); o.spins += 1; o.payout += Number(row.reward || 0);
    });

    const all = Array.from(agg.entries()).map(([id, v]) => ({ id, ...v }));
    const bySpins  = all.slice().sort((a,b)=> b.spins - a.spins || b.payout - a.payout).slice(0,200);
    const byPayout = all.slice().sort((a,b)=> b.payout - a.payout || b.spins - a.spins).slice(0,200);

    // Try multiple tables for name resolution (any that exist)
    const ids = all.map(r=>r.id);
    const nameMap = new Map();

    const sources = ['discord_users', 'server_members', 'users'];
    for (const tbl of sources) {
      const rows = await safeFetch(tbl, ids);
      for (const r of rows) {
        const id = String(r.discord_id);
        if (!nameMap.has(id)) {
          const nm = bestName(r);
          if (nm) nameMap.set(id, nm);
        }
      }
      if (nameMap.size === ids.length) break;
    }

    const shapedSpins = bySpins.map((r,i)=> ({
      rank: i+1, user: displayNameFor(r.id, nameMap), spins: r.spins, payout: r.payout
    }));
    const shapedPayout = byPayout.map((r,i)=> ({
      rank: i+1, user: displayNameFor(r.id, nameMap), spins: r.spins, payout: r.payout
    }));

    return res.status(200).json({ bySpins: shapedSpins, byPayout: shapedPayout });
  }catch(e){
    console.error('adminleaderboards error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
