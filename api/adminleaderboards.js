import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function bestName(o){
  // Try a wide set of possible column names that might exist in your schema
  return o?.display_name || o?.global_name || o?.username || o?.nick ||
         o?.nickname || o?.name || o?.handle || o?.discord_tag || null;
}
function toId(v){ return (v == null) ? '' : String(v); }

async function safeFetch(table, cols, build){
  try{
    const q = supabase.from(table).select(cols);
    const { data, error } = build ? await build(q) : await q;
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

    // All server tokens (enabled + disabled)
    const serverTokens = await safeFetch('server_tokens', 'contract_address', q => q.eq('server_id', server_id));
    const mints = (serverTokens||[]).map(r=>r.contract_address);
    if (!mints.length) return res.status(200).json({ bySpins:[], byPayout:[] });

    // Read spins from current + legacy tables
    const nowList = await safeFetch('daily_spins', 'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const legacy1 = await safeFetch('spins',        'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const legacy2 = await safeFetch('wheel_spins',  'discord_id,reward,contract_address', q => q.in('contract_address', mints));
    const spins = nowList.concat(legacy1, legacy2);

    // Aggregate per user (normalize IDs as strings)
    const agg = new Map();
    for (const row of (spins||[])) {
      const id = toId(row.discord_id);
      if (!id) continue;
      if (!agg.has(id)) agg.set(id, { spins:0, payout:0 });
      const o = agg.get(id); o.spins += 1; o.payout += Number(row.reward || 0);
    }
    const all = Array.from(agg.entries()).map(([id, v]) => ({ id, ...v }));
    const bySpins  = all.slice().sort((a,b)=> b.spins  - a.spins  || b.payout - a.payout).slice(0,200);
    const byPayout = all.slice().sort((a,b)=> b.payout - a.payout || b.spins  - a.spins ).slice(0,200);

    // Build a name map from any tables that might store usernames
    const ids = all.map(r=>r.id);
    const nameMap = new Map();

    const sources = [
      // table, columns
      ['discord_users', 'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag'],
      ['server_members','discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag'],
      ['users',         'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag'],
      ['spin_tokens',   'discord_id,username,display_name,global_name,nick,nickname,name,handle,discord_tag']
    ];
    for (const [tbl, cols] of sources) {
      const rows = await safeFetch(tbl, cols, q => q.in('discord_id', ids));
      for (const r of rows) {
        const id = toId(r.discord_id);
        if (!id || nameMap.has(id)) continue;
        const nm = bestName(r);
        if (nm) nameMap.set(id, nm);
      }
      if (nameMap.size === ids.length) break; // all resolved
    }

    const shape = (arr) => arr.map((r,i)=> ({
      rank: i+1,
      user: nameMap.get(r.id) || r.id, // fallback to ID if no name stored anywhere
      spins: r.spins,
      payout: r.payout
    }));

    return res.status(200).json({ bySpins: shape(bySpins), byPayout: shape(byPayout) });
  }catch(e){
    console.error('adminleaderboards error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
