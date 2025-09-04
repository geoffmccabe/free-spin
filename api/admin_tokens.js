import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function deny(res, code, msg){ return res.status(code).json({ error: msg }); }
function isDigits(x){ return typeof x === 'string' && /^[0-9]+$/.test(x); }
function isBase58(x){ return typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(x); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return deny(res, 405, 'Method not allowed');

  try {
    const { token: signedToken, server_id, action, contract_address } = req.body || {};
    if (!signedToken) return deny(res, 400, 'Token required');
    if (!server_id || !isDigits(server_id)) return deny(res, 400, 'Server ID required');

    const TOKEN_SECRET = process.env.SPIN_KEY;
    if (!TOKEN_SECRET) return deny(res, 500, 'Server configuration error');

    const [tokenPart, signature] = String(signedToken).split('.');
    if (!tokenPart || !signature) return deny(res, 400, 'Invalid token format');
    const expected = createHmac('sha256', TOKEN_SECRET).update(tokenPart).digest('hex');
    if (signature !== expected) return deny(res, 403, 'Invalid or forged token');

    // Who is the user?
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', signedToken)
      .single();
    if (tokErr || !tok) return deny(res, 400, 'Invalid token');

    const { data: admin, error: adminErr } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tok.discord_id)
      .eq('server_id', server_id)
      .single();
    if (adminErr || !admin || !['admin','superadmin'].includes(admin.role)) {
      return deny(res, 403, 'Admin only');
    }

    // list: any admin can view
    if (action === 'list' || !action) {
      const [{ data: st, error: stErr }, { data: cfg, error: cfgErr }] = await Promise.all([
        supabase.from('server_tokens').select('contract_address, enabled').eq('server_id', server_id),
        supabase.from('wheel_configurations').select('contract_address, token_name')
      ]);
      if (stErr) return deny(res, 400, stErr.message);
      if (cfgErr) return deny(res, 400, cfgErr.message);

      const nameByMint = new Map((cfg || []).map(r => [String(r.contract_address).trim(), r.token_name]));
      const tokens = (st || []).map(r => ({
        contract_address: r.contract_address,
        enabled: !!r.enabled,
        token_name: nameByMint.get(String(r.contract_address).trim()) || 'Token'
      }));
      return res.status(200).json({ tokens });
    }

    // Mutations require superadmin
    if (admin.role !== 'superadmin') return deny(res, 403, 'Superadmin required');

    if (action === 'disable' || action === 'enable') {
      if (!contract_address || !isBase58(contract_address)) return deny(res, 400, 'Valid contract_address required');
      const upd = await supabase
        .from('server_tokens')
        .update({ enabled: action === 'enable' })
        .eq('server_id', server_id)
        .eq('contract_address', contract_address);
      if (upd.error) return deny(res, 400, upd.error.message);
      return res.status(200).json({ ok: true });
    }

    if (action === 'add') {
      if (!contract_address || !isBase58(contract_address)) return deny(res, 400, 'Valid contract_address required');

      // must have wheel_configurations first (so wheel knows payouts)
      const { data: cfg, error: cfgErr } = await supabase
        .from('wheel_configurations')
        .select('contract_address')
        .eq('contract_address', contract_address)
        .single();
      if (cfgErr || !cfg) return deny(res, 400, 'Create wheel_configurations first for this mint');

      // insert if not present
      const { data: exists } = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .maybeSingle();

      if (!exists) {
        const ins = await supabase
          .from('server_tokens')
          .insert({ server_id, contract_address, enabled: true });
        if (ins.error) return deny(res, 400, ins.error.message);
      }
      return res.status(200).json({ ok: true });
    }

    return deny(res, 400, 'Unknown action');
  } catch (e) {
    console.error('admin_tokens fatal:', e);
    return deny(res, 500, 'Internal error');
  }
}
