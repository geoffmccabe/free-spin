import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, action, contract_address, enabled } = req.body || {};
    if (!token || !server_id || !action) return res.status(400).json({ error: 'token, server_id and action are required' });

    // Validate token => get discord_id
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });

    // Must be superadmin
    const { data: adminData } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tokenData.discord_id)
      .eq('server_id', server_id)
      .single();
    if (adminData?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

    if (action === 'list') {
      // list server tokens + config info
      const { data: tokens, error } = await supabase
        .from('server_tokens')
        .select('contract_address, enabled')
        .eq('server_id', server_id);
      if (error) throw error;

      const mints = (tokens || []).map(t => t.contract_address);
      let configs = [];
      if (mints.length) {
        const { data: cfg, error: cfgErr } = await supabase
          .from('wheel_configurations')
          .select('contract_address, token_name, image_url')
          .in('contract_address', mints);
        if (!cfgErr && cfg) configs = cfg;
      }

      const merged = (tokens || []).map(t => {
        const c = configs.find(x => x.contract_address === t.contract_address) || {};
        return { contract_address: t.contract_address, enabled: t.enabled !== false, token_name: c.token_name || '', image_url: c.image_url || '' };
      });

      return res.status(200).json({ tokens: merged });
    }

    if (action === 'add') {
      if (!contract_address) return res.status(400).json({ error: 'contract_address required' });
      // insert or enable
      const { data: existing } = await supabase
        .from('server_tokens')
        .select('contract_address, enabled')
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .maybeSingle();

      if (!existing) {
        const { error: insErr } = await supabase.from('server_tokens').insert({ server_id, contract_address, enabled: true });
        if (insErr) return res.status(400).json({ error: insErr.message });
      } else {
        // try to set enabled true
        const { error: updErr } = await supabase
          .from('server_tokens')
          .update({ enabled: true })
          .eq('server_id', server_id)
          .eq('contract_address', contract_address);
        if (updErr) {
          // fallback: do nothing (already exists)
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'setEnabled') {
      if (!contract_address || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'contract_address and enabled are required' });
      }

      // prefer enabled flag
      const { error: updErr } = await supabase
        .from('server_tokens')
        .update({ enabled })
        .eq('server_id', server_id)
        .eq('contract_address', contract_address);

      if (updErr) {
        // Fallback path if no 'enabled' column:
        if (!enabled) {
          const { error: delErr } = await supabase
            .from('server_tokens')
            .delete()
            .eq('server_id', server_id)
            .eq('contract_address', contract_address);
          if (delErr) return res.status(400).json({ error: delErr.message });
        } else {
          const { error: insErr } = await supabase
            .from('server_tokens')
            .insert({ server_id, contract_address });
          if (insErr) return res.status(400).json({ error: insErr.message });
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin/tokens error:', e.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
