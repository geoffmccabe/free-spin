import { createHmac, randomUUID } from 'crypto';
import { supabase, retryQuery, SPIN_URL, DEFAULT_TOKEN_ADDRESS } from './index.js';

function utcYYYYMMDD() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeTokenName(s) {
  return String(s || '').trim().toLowerCase();
}

async function handleSpinCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const server_id = interaction.guildId;
  const requestedTokenName = interaction.options.getString('token_name'); // may be null

  console.log(`Processing /spin for user: ${discord_id}, server: ${server_id}, token_name: ${requestedTokenName || '(default)'}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  // 1) Wallet must exist
  const { data: userData, error: userError } = await retryQuery(() =>
    supabase.from('users').select('wallet_address').eq('discord_id', discord_id).maybeSingle()
  );

  if (userError || !userData?.wallet_address) {
    console.error(`User query error: ${userError?.message || 'No wallet found'}`);
    return interaction.editReply({
      content: `❌ Please link your Solana wallet first using \`/mywallet\`.`,
      flags: 64
    });
  }

  // 2) Role
  const { data: adminData } = await retryQuery(() =>
    supabase.from('server_admins').select('role').eq('server_id', server_id).eq('discord_id', discord_id).maybeSingle()
  );
  const isSuperadmin = adminData?.role === 'superadmin';

  // 3) Enabled tokens for this server
  const { data: serverTokens, error: stErr } = await retryQuery(() =>
    supabase
      .from('server_tokens')
      .select('contract_address, is_default, enabled')
      .eq('server_id', server_id)
  );

  if (stErr) {
    console.error(`server_tokens query error: ${stErr.message}`);
    return interaction.editReply({ content: `❌ Database error loading server tokens.`, flags: 64 });
  }

  const enabledContracts = (serverTokens || [])
    .filter(t => t.enabled !== false)
    .map(t => t.contract_address);

  // If a server has no rows yet, fall back to DEFAULT_TOKEN_ADDRESS only if it has a wheel config
  const contractsToConsider = enabledContracts.length ? enabledContracts : [DEFAULT_TOKEN_ADDRESS];

  // 4) Load wheel configs for this server + those contracts (token_name, decimals, etc)
  const { data: configs, error: cfgErr } = await retryQuery(() =>
    supabase
      .from('wheel_configurations')
      .select('server_id, contract_address, token_name, decimals')
      .eq('server_id', server_id)
      .in('contract_address', contractsToConsider)
  );

  if (cfgErr) {
    console.error(`wheel_configurations query error: ${cfgErr.message}`);
    return interaction.editReply({ content: `❌ Database error loading wheel configuration.`, flags: 64 });
  }

  if (!configs || !configs.length) {
    return interaction.editReply({
      content: `❌ This server has no wheel configuration. Ask the admin to configure tokens and payouts.`,
      flags: 64
    });
  }

  // 5) Choose which coin to spin
  let chosen = null;

  if (requestedTokenName) {
    const wanted = normalizeTokenName(requestedTokenName);
    chosen = configs.find(c => normalizeTokenName(c.token_name) === wanted) || null;
    if (!chosen) {
      return interaction.editReply({
        content: `❌ Unknown token name for this server. Try autocomplete to select a valid token.`,
        flags: 64
      });
    }
  } else {
    const defaultRow = (serverTokens || []).find(t => t.is_default === true && t.enabled !== false);
    if (defaultRow) {
      chosen = configs.find(c => c.contract_address === defaultRow.contract_address) || null;
    }
    if (!chosen) chosen = configs[0];
  }

  const contract_address = chosen.contract_address;
  const token_name = chosen.token_name || 'Token';

  // 6) Enforce daily limit before generating link (DB also enforces later in /api/spin.js)
  if (!isSuperadmin) {
    const today = utcYYYYMMDD();
    const { count, error: cErr } = await retryQuery(() =>
      supabase
        .from('daily_spins')
        .select('id', { count: 'exact', head: true })
        .eq('server_id', server_id)
        .eq('discord_id', discord_id)
        .eq('contract_address', contract_address)
        .eq('spin_day', today)
    );

    if (cErr) {
      console.error(`Spin count error: ${cErr.message}`);
      return interaction.editReply({ content: `❌ Database error checking daily limit.`, flags: 64 });
    }

    if ((count || 0) >= 1) {
      return interaction.editReply({ content: `❌ Daily limit reached for ${token_name}.`, flags: 64 });
    }
  }

  // 7) Create signed spin token (stored in spin_tokens with status=issued)
  const raw = randomUUID();
  const key = process.env.SPIN_KEY;
  if (!key) {
    console.error('Missing SPIN_KEY env var');
    return interaction.editReply({ content: `❌ Server misconfigured (missing SPIN_KEY).`, flags: 64 });
  }
  const sig = createHmac('sha256', key).update(raw).digest('hex');
  const signedToken = `${raw}.${sig}`;

  const { data: tokenData, error: tokenError } = await retryQuery(() =>
    supabase
      .from('spin_tokens')
      .insert({
        token: signedToken,
        server_id,
        discord_id,
        wallet_address: userData.wallet_address,
        contract_address,
        status: 'issued'
      })
      .select('token')
      .single()
  );

  if (tokenError || !tokenData?.token) {
    console.error(`Spin token insert error: ${tokenError?.message || 'unknown'}`);
    return interaction.editReply({ content: `❌ Failed to create spin link.`, flags: 64 });
  }

  // 8) Build URL exactly as configured
  const base = (SPIN_URL || '').trim();
  const sep = base.includes('?') ? '&' : '?';
  const spinUrl = `${base}${sep}token=${encodeURIComponent(tokenData.token)}&server_id=${encodeURIComponent(server_id)}`;

  const spinsLeftText = isSuperadmin ? `Unlimited spins` : `1 spin per day`;
  return interaction.editReply({
    content: `✅ Your spin for **${token_name}** is ready:\n${spinUrl}\n${spinsLeftText}`,
    flags: 64
  });
}

async function handleWalletCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const wallet_address = interaction.options.getString('address');

  console.log(`Processing wallet command for user: ${discord_id}, address: ${wallet_address || '(view)'}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  if (wallet_address) {
    if (!wallet_address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      return interaction.editReply({ content: `❌ Invalid Solana wallet address.`, flags: 64 });
    }

    const { data, error } = await retryQuery(() =>
      supabase
        .from('users')
        .upsert({ discord_id, wallet_address })
        .select('wallet_address')
        .single()
    );

    if (error || !data?.wallet_address) {
      console.error(`Wallet upsert error: ${error?.message || 'unknown'}`);
      return interaction.editReply({ content: `❌ Failed to save wallet address.`, flags: 64 });
    }

    return interaction.editReply({ content: `✅ Wallet saved: \`${data.wallet_address}\``, flags: 64 });
  }

  const { data, error } = await retryQuery(() =>
    supabase.from('users').select('wallet_address').eq('discord_id', discord_id).maybeSingle()
  );

  if (error || !data?.wallet_address) {
    return interaction.editReply({
      content: `❌ No wallet address found. Set one with \`/mywallet <address>\`.`,
      flags: 64
    });
  }

  return interaction.editReply({ content: `ℹ️ Your wallet address: \`${data.wallet_address}\``, flags: 64 });
}

async function handleSetTokenCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const server_id = interaction.guildId;
  const contract_address = interaction.options.getString('contract_address');
  const remove = interaction.options.getBoolean('remove') || false;
  const set_default = interaction.options.getBoolean('default') || false;
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] /settoken user:${discord_id} server:${server_id} contract:${contract_address} remove:${remove} default:${set_default}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`[${timestamp}] Defer reply failed: ${error.message}`);
    return;
  }

  // Must be superadmin
  const { data: adminRow } = await retryQuery(() =>
    supabase.from('server_admins').select('role').eq('server_id', server_id).eq('discord_id', discord_id).maybeSingle()
  );
  if (adminRow?.role !== 'superadmin') {
    return interaction.editReply({ content: `❌ Only superadmins can use /settoken.`, flags: 64 });
  }

  // Wheel config must exist for this server+coin
  const { data: cfg, error: cfgErr } = await retryQuery(() =>
    supabase
      .from('wheel_configurations')
      .select('token_name, decimals')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address)
      .maybeSingle()
  );

  if (cfgErr || !cfg) {
    return interaction.editReply({
      content: `❌ Not configured: add a wheel configuration for this server and token first.`,
      flags: 64
    });
  }

  if (remove) {
    const { error } = await retryQuery(() =>
      supabase.from('server_tokens').delete().eq('server_id', server_id).eq('contract_address', contract_address)
    );
    if (error) return interaction.editReply({ content: `❌ Failed to remove token.`, flags: 64 });
    return interaction.editReply({ content: `✅ Removed token **${cfg.token_name}** from this server.`, flags: 64 });
  }

  // If setting default, clear other defaults first (unique partial index enforces it too)
  if (set_default) {
    await retryQuery(() =>
      supabase.from('server_tokens').update({ is_default: false }).eq('server_id', server_id)
    );
  }

  const { error } = await retryQuery(() =>
    supabase
      .from('server_tokens')
      .upsert({
        server_id,
        contract_address,
        mint_address: contract_address,
        decimals: cfg.decimals,
        enabled: true,
        is_default: set_default
      })
  );

  if (error) return interaction.editReply({ content: `❌ Failed to add token.`, flags: 64 });

  return interaction.editReply({
    content: `✅ Enabled token **${cfg.token_name}** for this server${set_default ? ' as default' : ''}.`,
    flags: 64
  });
}

async function handleHelpCommand(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  return interaction.editReply({
    content:
      `Commands:\n` +
      `• /mywallet (set or view wallet)\n` +
      `• /spin (get a spin link)\n` +
      `• /leaders (view leaderboard)\n`,
    flags: 64
  });
}

export { handleSpinCommand, handleWalletCommand, handleHelpCommand, handleSetTokenCommand };
