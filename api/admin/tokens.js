import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// read server_tokens with/without enabled column
async function selectServerTokensMaybeEnabled(server_id){
  let supportsEnabled = true, rows = [];
  let { data, error } = await supabase
    .from('server_tokens')
    .select('contract_address, enabled')
    .eq('server_id', server_id);
  if (error) {
    const msg = (error.message||'').toLowerCase() + ' ' + (error.details||'').toLowerCase();
    if (msg.includes('enabled')) {
      supportsEnabled = false;
      const fb = await supabase.from('server_tokens').select('contract_address').eq('server_id', server_id);
      if (fb.error) return { error: fb.error, supportsEnabled: false, rows: [] };
      rows = (fb.data||[]).map(r => ({ contract_address: r.contract_address, enabled: true }));
    } else {
      return { error, supportsEnabled: true, rows: [] };
    }
  } else rows = data || [];
  return { rows, supportsEnabled, error: null };
}

export default async function handler(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  try{
    const { token, server_id, action, contract_address, enabled } = req.body || {};
    if (!token || !server_id || !action) return res.status(400).json({ error:'token, server_id and action are required' });

    // token -> discord_id
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens').select('discord_id').eq('token', token).single();
    if (tokErr || !tok) return res.status(400).json({ error:'Invalid token' });

    // require superadmin
    const { data: adm, error: admErr } = await supabase
      .from('server_admins').select('role').eq('discord_id', tok.discord_id).eq('server_id', server_id).single();
    if (admErr) return res.status(400).json({ error: admErr.message });
    if (adm?.role !== 'superadmin') return res.status(403).json({ error:'Superadmin access required' });

    if (action === 'list') {
      const sel = await selectServerTokensMaybeEnabled(server_id);
      if (sel.error) return res.status(400).json({ error: sel.error.message });

      // join with wheel_configurations for names/images
      const mints = (sel.rows||[]).map(r => r.contract_address);
      const { data: cfg } = mints.length
        ? await supabase.from('wheel_configurations')
            .select('contract_address, token_name, image_url')
            .in('contract_address', mints)
        : { data: [] };

      // IMPORTANT: never hide disabled tokens (e.g., FATCOIN remains visible)
      const tokens = (sel.rows||[]).map(t => {
        const c = (cfg||[]).find(x => x.contract_address === t.contract_address) || {};
        return {
          contract_address: t.contract_address,
          token_name: c.token_name || '',
          image_url: c.image_url || '',
          enabled: (typeof t.enabled === 'boolean') ? t.enabled : true
        };
      });
      return res.status(200).json({ tokens, supportsEnabled: sel.supportsEnabled });
    }

    if (action === 'add') {
      if (!contract_address) return res.status(400).json({ error:'contract_address required' });
      // upsert with enabled true if column exists; fallback if not
      let { error: upErr } = await supabase
        .from('server_tokens')
        .upsert({ server_id, contract_address, enabled: true }, { onConflict:'server_id,contract_address' });
      if (upErr) {
        const msg = (upErr.message||'').toLowerCase() + ' ' + (upErr.details||'').toLowerCase();
        if (msg.includes('enabled')) {
          const fb = await supabase
            .from('server_tokens')
            .upsert({ server_id, contract_address }, { onConflict:'server_id,contract_address' });
          if (fb.error) return res.status(400).json({ error: fb.error.message });
          return res.status(200).json({ ok:true, supportsEnabled:false });
        }
        return res.status(400).json({ error: upErr.message });
      }
      return res.status(200).json({ ok:true, supportsEnabled:true });
    }

    if (action === 'setEnabled') {
      if (!contract_address || typeof enabled !== 'boolean') {
        return res.status(400).json({ error:'contract_address and enabled are required' });
      }
      const { error: updErr } = await supabase
        .from('server_tokens')
        .update({ enabled })
        .eq('server_id', server_id)
        .eq('contract_address', contract_address);
      if (updErr) {
        const msg = (updErr.message||'').toLowerCase() + ' ' + (updErr.details||'').toLowerCase();
        if (msg.includes('enabled')) {
          return res.status(409).json({
            error:'Feature not enabled',
            migration:"Run once:\nALTER TABLE server_tokens ADD COLUMN enabled boolean DEFAULT true;\nUPDATE server_tokens SET enabled = true WHERE enabled IS NULL;"
          });
        }
        return res.status(400).json({ error: updErr.message });
      }
      return res.status(200).json({ ok:true });
    }

    return res.status(400).json({ error:'Unknown action' });
  }catch(e){
    console.error('admin/tokens error:', e);
    return res.status(500).json({ error:'Internal error' });
  }
}
