
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Detect whether server_tokens.enabled exists by attempting a select with it.
async function detectEnabledColumn(server_id) {
  const probe = await supabase
    .from('server_tokens')
    .select('contract_address,enabled')
    .eq('server_id', server_id)
    .limit(1);
  if (probe.error) {
    const msg = (probe.error.message || '').toLowerCase();
    if (msg.includes('column') && msg.includes('enabled') && msg.includes('does not exist')) {
      return { hasEnabled: false };
    }
    // Some other error (permissions, etc.) – treat as no-enabled support but continue
    return { hasEnabled: false };
  }
  return { hasEnabled: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, server_id, action, contract_address, enabled } = req.body || {};
    if (!token || !server_id || !action) return res.status(400).json({ error: 'token, server_id and action are required' });

    // Validate token -> discord_id
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id')
      .eq('token', token)
      .single();
    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });

    // Must be superadmin
    const { data: adminData, error: adminErr } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', tokenData.discord_id)
      .eq('server_id', server_id)
      .single();
    if (adminErr) return res.status(400).json({ error: adminErr.message });
    if (adminData?.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });

    const { hasEnabled } = await detectEnabledColumn(server_id);

    if (action === 'list') {
      let rows, err;
      if (hasEnabled) {
        const q = await supabase
          .from('server_tokens')
          .select('contract_address, enabled')
          .eq('server_id', server_id);
        rows = q.data; err = q.error;
      } else {
        const q = await supabase
          .from('server_tokens')
          .select('contract_address')
          .eq('server_id', server_id);
        rows = (q.data || []).map(r => ({ contract_address: r.contract_address, enabled: true }));
        err = q.error;
      }
      if (err) return res.status(400).json({ error: err.message });

      const mints = (rows || []).map(r => r.contract_address);
      let cfg = [];
      if (mints.length) {
        const qc = await supabase
          .from('wheel_configurations')
          .select('contract_address, token_name, image_url')
          .in('contract_address', mints);
        cfg = qc.data || [];
      }

      const merged = (rows || []).map(t => {
        const c = cfg.find(x => x.contract_address === t.contract_address) || {};
        return {
          contract_address: t.contract_address,
          token_name: c.token_name || '',
          image_url: c.image_url || '',
          enabled: !!t.enabled
        };
      });

      return res.status(200).json({ tokens: merged, supportsEnabledFlag: hasEnabled });
    }

    if (action === 'add') {
      if (!contract_address) return res.status(400).json({ error: 'contract_address required' });
      if (hasEnabled) {
        const up = await supabase
          .from('server_tokens')
          .upsert({ server_id, contract_address, enabled: true }, { onConflict: 'server_id,contract_address' });
        if (up.error) return res.status(400).json({ error: up.error.message });
      } else {
        const exists = await supabase
          .from('server_tokens')
          .select('contract_address')
          .eq('server_id', server_id)
          .eq('contract_address', contract_address)
          .maybeSingle();
        if (!exists.data) {
          const ins = await supabase.from('server_tokens').insert({ server_id, contract_address });
          if (ins.error) return res.status(400).json({ error: ins.error.message });
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'setEnabled') {
      if (!contract_address || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'contract_address and enabled are required' });
      }
      if (hasEnabled) {
        const upd = await supabase
          .from('server_tokens')
          .update({ enabled })
          .eq('server_id', server_id)
          .eq('contract_address', contract_address);
        if (upd.error) return res.status(400).json({ error: upd.error.message });
      } else {
        // Fallback: simulate enabled by delete/insert (row disappears when disabled)
        if (enabled === false) {
          const del = await supabase
            .from('server_tokens')
            .delete()
            .eq('server_id', server_id)
            .eq('contract_address', contract_address);
          if (del.error) return res.status(400).json({ error: del.error.message });
        } else {
          const ins = await supabase
            .from('server_tokens')
            .insert({ server_id, contract_address });
          if (ins.error) return res.status(400).json({ error: ins.error.message });
        }
      }
      return res.status(200).json({ ok: true, supportsEnabledFlag: hasEnabled });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin/tokens error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
