import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Attempt to fetch enabled column; fallback if column doesn't exist.
async function selectServerTokensWithMaybeEnabled(server_id) {
  let supportsEnabled = true;
  let rows = [];
  let { data, error } = await supabase
    .from('server_tokens')
    .select('contract_address, enabled')
    .eq('server_id', server_id);

  if (error) {
    if ((error.message||'').toLowerCase().includes('enabled') || (error.details||'').toLowerCase().includes('enabled')) {
      supportsEnabled = false;
      const fb = await supabase.from('server_tokens').select('contract_address').eq('server_id', server_id);
      if (fb.error) return { error: fb.error, rows: [], supportsEnabled: false };
      rows = (fb.data || []).map(r => ({ contract_address: r.contract_address, enabled: true }));
    } else {
      return { error, rows: [], supportsEnabled: true };
    }
  } else {
    rows = data || [];
  }

  return { rows, supportsEnabled, error: null };
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

    if (action === 'list') {
      const sel = await selectServerTokensWithMaybeEnabled(server_id);
      if (sel.error) return res.status(400).json({ error: sel.error.message });

      // Join with wheel_configurations so tokens show names even if disabled
      const mints = (sel.rows || []).map(r => r.contract_address);
      const { data: cfg, error: cfgErr } = mints.length
        ? await supabase.from('wheel_configurations')
            .select('contract_address, token_name, image_url')
            .in('contract_address', mints)
        : { data: [], error: null };
      if (cfgErr) console.error('tokens list config error:', cfgErr.message);

      const merged = (sel.rows || []).map(t => {
        const c = (cfg || []).find(x => x.contract_address === t.contract_address) || {};
        return {
          contract_address: t.contract_address,
          token_name: c.token_name || '',
          image_url: c.image_url || '',
          enabled: (typeof t.enabled === 'boolean') ? t.enabled : true
        };
      });

      // IMPORTANT: do not hide disabled tokens (e.g., FATCOIN stays visible)
      return res.status(200).json({ tokens: merged, supportsEnabled: sel.supportsEnabled });
    }

    if (action === 'add') {
      if (!contract_address) return res.status(400).json({ error: 'contract_address required' });

      // Upsert with enabled true if column exists; fallback to upsert without it otherwise
      let { error: upErr } = await supabase
        .from('server_tokens')
        .upsert({ server_id, contract_address, enabled: true }, { onConflict: 'server_id,contract_address' });
      if (upErr && ((upErr.message||'').toLowerCase().includes('enabled') || (upErr.details||'').toLowerCase().includes('enabled'))) {
        const fb = await supabase
          .from('server_tokens')
          .upsert({ server_id, contract_address }, { onConflict: 'server_id,contract_address' });
        if (fb.error) return res.status(400).json({ error: fb.error.message });
        return res.status(200).json({ ok: true, supportsEnabled: false });
      }
      if (upErr) return res.status(400).json({ error: upErr.message });
      return res.status(200).json({ ok: true, supportsEnabled: true });
    }

    if (action === 'setEnabled') {
      if (!contract_address || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'contract_address and enabled are required' });
      }
      const { error: updErr } = await supabase
        .from('server_tokens')
        .update({ enabled })
        .eq('server_id', server_id)
        .eq('contract_address', contract_address);
      if (updErr) {
        if ((updErr.message||'').toLowerCase().includes('enabled') || (updErr.details||'').toLowerCase().includes('enabled')) {
          return res.status(409).json({
            error: 'Feature not enabled',
            migration: "Run once:\nALTER TABLE server_tokens ADD COLUMN enabled boolean DEFAULT true;\nUPDATE server_tokens SET enabled = true WHERE enabled IS NULL;"
          });
        }
        return res.status(400).json({ error: updErr.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('admin/tokens error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
