import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function deny(res, code, msg) { return res.status(code).json({ error: msg }); }
function isDigits(x) { return typeof x === 'string' && /^[0-9]+$/.test(x); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return deny(res, 405, 'Method not allowed');

  try {
    const { token: signedToken, server_id, sortBy = 'spins' } = req.body || {};
    if (!signedToken) return deny(res, 400, 'Token required');
    if (!server_id || !isDigits(server_id)) return deny(res, 400, 'Server ID required');

    const TOKEN_SECRET = process.env.SPIN_KEY;
    if (!TOKEN_SECRET) return deny(res, 500, 'Server configuration error');

    // Verify "<token>.<hmac>"
    const [tokenPart, signature] = String(signedToken).split('.');
    if (!tokenPart || !signature) return deny(res, 400, 'Invalid token format');
    const expected = createHmac('sha256', TOKEN_SECRET).update(tokenPart).digest('hex');
    if (signature !== expected) return deny(res, 403, 'Invalid or forged token');

    // Identify caller
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', signedToken)
      .single();
    if (tokErr || !tok) return deny(res, 400, 'Invalid token');

    // Must be admin/superadmin on this server
    const { data: admin, error: adminErr } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tok.discord_id)
      .eq('server_id', server_id)
      .single();
    if (adminErr || !admin || !['admin', 'superadmin'].includes(admin.role)) {
      return deny(res, 403, 'Admin only');
    }

    // Get all mints for this server (enabled or not) for legacy rows
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);

    if (stErr) return deny(res, 400, stErr.message);
    const mints = (st || []).map(r => String(r.contract_address || '').trim()).filter(Boolean);

    // Fetch new rows (server_id stamped)
    let rows = [];
    const a = await supabase
      .from('daily_spins')
      .select('discord_id,reward')
      .eq('server_id', server_id);
    if (!a.error && a.data) rows = rows.concat(a.data);

    // Fetch legacy rows (no server_id) only for this server's mints
    if (mints.length) {
      const b = await supabase
        .from('daily_spins')
        .select('discord_id,reward,contract_address')
        .is('server_id', null)
        .in('contract_address', mints);
      if (!b.error && b.data) rows = rows.concat(b.data);
    }

    // Aggregate by discord_id
    const agg = new Map(); // id -> { spins, payout }
    for (const r of rows) {
      const id = r.discord_id;
      if (!id) continue;
      if (!agg.has(id)) agg.set(id, { spins: 0, payout: 0 });
      const cur = agg.get(id);
      cur.spins += 1;
      cur.payout += Number(r.reward || 0);
    }

    // Enrich with usernames
    const ids = Array.from(agg.keys());
    let nameMap = new Map();
    if (ids.length) {
      const u = await supabase
        .from('discord_users')
        .select('discord_id, username, display_name, global_name, nick, nickname, name, handle, discord_tag')
        .in('discord_id', ids);
      if (!u.error && u.data) {
        for (const r of u.data) {
          const name =
            r.display_name || r.global_name || r.username || r.nick || r.nickname || r.name || r.handle || r.discord_tag || r.discord_id;
          nameMap.set(r.discord_id, name);
        }
      }
    }

    let out = ids.map(id => ({
      discord_id: id,
      username: nameMap.get(id) || id,
      spins: agg.get(id).spins,
      payout: agg.get(id).payout
    }));

    if (sortBy === 'payout') {
      out.sort((a, b) => b.payout - a.payout);
    } else {
      out.sort((a, b) => b.spins - a.spins);
    }

    out = out.slice(0, 200);

    return res.status(200).json({ rows: out });
  } catch (e) {
    console.error('adminleaderboards fatal:', e);
    return deny(res, 500, 'Internal error');
  }
}
