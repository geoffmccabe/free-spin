import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchServerTokens(server_id) {
  // Try to include enabled; if column missing, treat as enabled
  try {
    const { data, error } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);
    if (error) throw error;
    return (data || []).map(r => ({
      contract_address: String(r.contract_address || '').trim(),
      enabled: r.enabled === null ? true : !!r.enabled,
      missingEnabled: false
    })).filter(r => r.contract_address.length > 0);
  } catch (e) {
    const msg = ((e?.message || '') + ' ' + (e?.details || '')).toLowerCase();
    if (msg.includes('enabled')) {
      const fb = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (fb.error) throw fb.error;
      return (fb.data || []).map(r => ({
        contract_address: String(r.contract_address || '').trim(),
        enabled: true,
        missingEnabled: true
      })).filter(r => r.contract_address.length > 0);
    }
    throw e;
  }
}

async function fetchTokenMeta(contractAddresses) {
  if (!contractAddresses.length) return {};
  const { data, error } = await supabase
    .from('wheel_configurations')
    .select('contract_address, token_name, image_url')
    .in('contract_address', contractAddresses);
  if (error) return {};
  const map = {};
  for (const r of (data || [])) {
    const ca = String(r.contract_address || '').trim();
    if (!ca) continue;
    map[ca] = {
      token_name: r.token_name || null,
      image_url: r.image_url || null,
    };
  }
  return map;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { token, server_id, action, contract_address: addrRaw } = req.body || {};
    if (!token || !server_id) return res.status(400).json({ error: 'token and server_id required' });

    // Validate token + role
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error: 'Invalid token' });

    const { data: adminData } = await supabase
      .from('server_admins').select('role').eq('discord_id', tok.discord_id).eq('server_id', server_id).single();
    const role = adminData?.role || null;
    const isAdmin = role === 'admin' || role === 'superadmin';
    if (!isAdmin) return res.status(403).json({ error: 'Admins only' });

    if (action === 'list' || !action) {
      const rows = await fetchServerTokens(server_id);
      const nameMap = await fetchTokenMeta(rows.map(r => r.contract_address));
      const items = rows.map(r => ({
        contract_address: r.contract_address,
        enabled: r.enabled,
        missingEnabled: r.missingEnabled,
        token_name: nameMap[r.contract_address]?.token_name || null,
        image_url: nameMap[r.contract_address]?.image_url || null
      }));
      return res.status(200).json({ items });
    }

    if (action === 'toggle') {
      const addr = String(addrRaw || '').trim();
      if (!addr) return res.status(400).json({ error: 'contract_address required' });

      // ensure enabled column exists
      const probe = await supabase.from('server_tokens').select('enabled').limit(1);
      if (probe.error) {
        const msg = ((probe.error.message || '') + ' ' + (probe.error.details || '')).toLowerCase();
        if (msg.includes('enabled')) {
          return res.status(400).json({
            error: 'missing-enabled',
            hint: "Run once: ALTER TABLE server_tokens ADD COLUMN enabled boolean DEFAULT true;"
          });
        }
      }

      const { data: cur, error: curErr } = await supabase
        .from('server_tokens')
        .select('enabled')
        .eq('server_id', server_id)
        .eq('contract_address', addr)
        .single();
      if (curErr || !cur) return res.status(400).json({ error: 'Token not found on this server' });

      const { error: updErr } = await supabase
        .from('server_tokens')
        .update({ enabled: !cur.enabled })
        .eq('server_id', server_id)
        .eq('contract_address', addr);
      if (updErr) return res.status(400).json({ error: updErr.message });

      return res.status(200).json({ ok: true, enabled: !cur.enabled });
    }

    if (action === 'add') {
      const addr = String(addrRaw || '').trim();
      if (!addr) return res.status(400).json({ error: 'contract_address required' });
      const { error: insErr } = await supabase
        .from('server_tokens')
        .upsert({ server_id, contract_address: addr, enabled: true }, { onConflict: 'server_id,contract_address' });
      if (insErr) return res.status(400).json({ error: insErr.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin/tokens fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
