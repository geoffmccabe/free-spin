import { createHmac, randomUUID } from 'crypto';
import { supabase, retryQuery, SPIN_CHANNEL_NAME, SPIN_URL, DEFAULT_TOKEN_ADDRESS } from './index.js';

async function handleSpinCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const server_id = interaction.guildId;
  console.log(`Processing /spin for user: ${discord_id}, server: ${server_id}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  const [
    { data: userData, error: userError },
    { data: serverTokens, error: serverTokenError },
    { data: adminData, error: adminError },
    { data: userPref, error: prefError }
  ] = await Promise.all([
    retryQuery(() => supabase.from('users').select('wallet_address, spin_limit').eq('discord_id', discord_id).maybeSingle()),
    retryQuery(() => supabase.from('server_tokens').select('contract_address, default_token').eq('server_id', server_id)),
    retryQuery(() => supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).maybeSingle()),
    retryQuery(() => supabase.from('user_preferences').select('last_token').eq('discord_id', discord_id).eq('server_id', server_id).maybeSingle())
  ]);

  if (userError || !userData?.wallet_address) {
    console.error(`User query error: ${userError?.message || 'No wallet found'}`);
    return interaction.editReply({ content: `❌ Please link your Solana wallet first using the \`/mywallet\` command.`, flags: 64 });
  }

  const isSuperadmin = adminData?.role === 'superadmin';
  console.log(`Admin check: ${discord_id} is ${isSuperadmin ? '' : 'not '}superadmin`);

  let contract_addresses = serverTokens?.map(t => t.contract_address) || [];
  let default_token = serverTokens?.find(t => t.default_token)?.contract_address || DEFAULT_TOKEN_ADDRESS;
  if (contract_addresses.length === 0) {
    contract_addresses = [DEFAULT_TOKEN_ADDRESS];
    console.log(`No server-specific tokens for server ${server_id}, using default: ${contract_addresses[0]}`);
  } else {
    console.log(`Server tokens found: ${contract_addresses.join(', ')}, default: ${default_token}`);
  }

  const { data: coinData, error: coinError } = await retryQuery(() =>
    supabase.from('wheel_configurations').select('contract_address, token_name').in('contract_address', contract_addresses)
  );
  if (coinError || !coinData?.length) {
    console.error(`Coin query error: ${coinError?.message || 'No coins found'}`);
    return interaction.editReply({ content: `❌ No tokens available for spinning on this server.`, flags: 64 });
  }
  console.log(`Available coins: ${JSON.stringify(coinData)}`);

  const token_name = interaction.options.getString('token_name');
  let selected_token = token_name ? coinData.find(c => c.token_name === token_name)?.contract_address : null;
  if (!selected_token && !token_name) {
    selected_token = userPref?.last_token || default_token;
  }
  if (!selected_token || !contract_addresses.includes(selected_token)) {
    selected_token = default_token;
  }
  const coin = coinData.find(c => c.contract_address === selected_token);
  if (!coin) {
    console.error(`Invalid token selected: ${selected_token}`);
    return interaction.editReply({ content: `❌ Invalid token selected.`, flags: 64 });
  }
  console.log(`Selected token for spin: ${coin.token_name} (${coin.contract_address})`);

  const availableCoinsToSpin = [];
  let spinsLeft = userData.spin_limit;
  if (!isSuperadmin) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSpins, error: spinCountError } = await retryQuery(() =>
      supabase.from('daily_spins').select('contract_address').eq('discord_id', discord_id).gte('created_at', twentyFourHoursAgo)
    );
    if (spinCountError) {
      console.error(`Spin count error: ${spinCountError.message}`);
      return interaction.editReply({ content: `❌ Database error checking spin count.`, flags: 64 });
    }
    const totalSpinsToday = recentSpins.length;
    spinsLeft = Math.max(0, userData.spin_limit - totalSpinsToday);
    if (totalSpinsToday >= userData.spin_limit) {
      console.log(`Spin limit exceeded for discord_id: ${discord_id}`);
      return interaction.editReply({ content: `❌ You have used all your ${userData.spin_limit} daily spins today. Try again tomorrow!`, flags: 64 });
    }
    const spunContracts = recentSpins.map(s => s.contract_address);
    for (const coin of coinData) {
      if (!spunContracts.includes(coin.contract_address)) {
        availableCoinsToSpin.push(coin);
      }
    }
    if (availableCoinsToSpin.length === 0) {
      return interaction.editReply({ content: `❌ You have already spun all available tokens today. Try again tomorrow!`, flags: 64 });
    }
  } else {
    console.log(`Bypassing spin limit for superadmin: ${discord_id}`);
    availableCoinsToSpin.push(...coinData);
    spinsLeft = 'Unlimited';
  }

  const secretKey = process.env.SPIN_KEY;
  if (!secretKey) {
    console.error("FATAL: SPIN_KEY environment variable not found or is empty.");
    return interaction.editReply({ content: `❌ A server configuration error occurred. Please notify an administrator.`, flags: 64 });
  }

  const token = randomUUID();
  const signature = createHmac('sha256', secretKey).update(token).digest('hex');
  const signedToken = `${token}.${signature}`;

  const { data: tokenData, error: tokenError } = await retryQuery(() =>
    supabase.from('spin_tokens').insert({
      discord_id,
      wallet_address: userData.wallet_address,
      contract_address: coin.contract_address,
      token: signedToken,
      used: false
    }).select('token').maybeSingle()
  );
  if (tokenError) {
    console.error(`Token insert error: ${tokenError.message}`);
    return interaction.editReply({ content: `❌ Failed to generate spin token.`, flags: 64 });
  }
  console.log(`Inserting spin token: ${tokenData.token}`);

  await retryQuery(() =>
    supabase.from('user_preferences').upsert({
      discord_id,
      server_id,
      last_token: coin.contract_address
    })
  );

  const spinUrl = `${SPIN_URL}/index.html?token=${tokenData.token}&server_id=${server_id}`;
  const spinsLeftText = typeof spinsLeft === 'number' ? `${spinsLeft} spin${spinsLeft === 1 ? '' : 's'} left today` : 'Unlimited spins';
  console.log(`Sending spin URL: ${spinUrl}`);
  return interaction.editReply({ content: `Your spin is ready! Click here: ${spinUrl}\n${spinsLeftText}`, flags: 64 });
}

async function handleWalletCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const wallet_address = interaction.options.getString('address');
  console.log(`Processing wallet command for user: ${discord_id}, address: ${wallet_address}`);

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
      supabase.from('users').upsert({ discord_id, wallet_address, spin_limit: 1 }).select('wallet_address').maybeSingle()
    );
    if (error) {
      console.error(`Wallet upsert error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to save wallet address.`, flags: 64 });
    }
    console.log(`Wallet saved: ${data?.wallet_address}`);
    return interaction.editReply({ content: `✅ Wallet address saved: \`${data?.wallet_address}\``, flags: 64 });
  } else {
    const { data, error } = await retryQuery(() =>
      supabase.from('users').select('wallet_address').eq('discord_id', discord_id).maybeSingle()
    );
    if (error || !data?.wallet_address) {
      console.error(`Wallet query error: ${error?.message || 'No wallet found'}`);
      return interaction.editReply({ content: `❌ No wallet address found. Please provide one using \`/mywallet <address>\`.`, flags: 64 });
    }
    console.log(`Wallet retrieved: ${data.wallet_address}`);
    return interaction.editReply({ content: `ℹ️ Your wallet address: \`${data.wallet_address}\``, flags: 64 });
  }
}

async function handleHelpCommand(interaction) {
  console.log(`Processing help command`);
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  const helpText = `
**Free-Spin Bot Commands**
- **/spin [token_name]**: Spin the wheel to win $HAROLD or other tokens (limited daily).
- **/mywallet [address]**: Link or view your Solana wallet address.
- **/spinleaders [token_name]**: View the leaderboard for a specific token.
- **/spinhelp**: Show this help message.
- **/settoken <contract_address> [remove] [default]**: (Superadmin only) Add or remove a token for this server.
  `;
  return interaction.editReply({ content: helpText, flags: 64 });
}

async function handleSetTokenCommand(interaction, supabase, retryQuery) {
  const discord_id = interaction.user.id;
  const server_id = interaction.guildId;
  const contract_address = interaction.options.getString('contract_address');
  const remove = interaction.options.getBoolean('remove') || false;
  const set_default = interaction.options.getBoolean('default') || false;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Processing /settoken for user: ${discord_id}, server: ${server_id}, contract: ${contract_address}, remove: ${remove}, default: ${set_default}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`[${timestamp}] Defer reply failed: ${error.message}`);
    return;
  }

  const { data: adminData, error: adminError } = await retryQuery(() =>
    supabase.from('server_admins').select('role').eq('server_id', server_id).eq('discord_id', discord_id).maybeSingle()
  );
  const isOwner = interaction.guild.ownerId === discord_id;
  if (adminError || adminData?.role !== 'superadmin') {
    const errorMsg = isOwner 
      ? `[${timestamp}] Server owner ${discord_id} attempted /settoken for ${contract_address} without superadmin role on server ${server_id}`
      : `[${timestamp}] Unauthorized /settoken by ${discord_id} for ${contract_address} on ${server_id}`;
    console.error(errorMsg);
    return interaction.editReply({ content: `❌ You must be a superadmin on this server to use this command.`, flags: 64 });
  }
  console.log(`[${timestamp}] Superadmin role verified for ${discord_id}`);

  if (!contract_address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
    return interaction.editReply({ content: `❌ Invalid contract address.`, flags: 64 });
  }

  const { data: configData, error: configError } = await retryQuery(() =>
    supabase.from('wheel_configurations').select('token_name').eq('contract_address', contract_address).maybeSingle()
  );
  if (configError || !configData) {
    console.error(`[${timestamp}] Config error: ${configError?.message || 'No config found'}`);
    return interaction.editReply({ content: `❌ Invalid token: Not configured in the system.`, flags: 64 });
  }
  console.log(`[${timestamp}] Token verified: ${configData.token_name}`);

  if (remove) {
    const { error } = await retryQuery(() =>
      supabase.from('server_tokens').delete().eq('server_id', server_id).eq('contract_address', contract_address)
    );
    if (error) {
      console.error(`[${timestamp}] Token delete error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to remove token.`, flags: 64 });
    }
    console.log(`[${timestamp}] Token removed: ${contract_address} by ${discord_id} on ${server_id}`);
    return interaction.editReply({ content: `✅ Token ${configData.token_name} removed from this server.`, flags: 64 });
  } else {
    const { data, error } = await retryQuery(() =>
      supabase.from('server_tokens').upsert({ 
        server_id, 
        contract_address, 
        default_token: set_default 
      }).select('contract_address').maybeSingle()
    );
    if (error) {
      console.error(`[${timestamp}] Token insert error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to add token.`, flags: 64 });
    }
    console.log(`[${timestamp}] Token added: ${data.contract_address} by ${discord_id} on ${server_id}, default: ${set_default}`);
    return interaction.editReply({ content: `✅ Token ${configData.token_name} added to this server${set_default ? ' as default' : ''}.`, flags: 64 });
  }
}

export { handleSpinCommand, handleWalletCommand, handleHelpCommand, handleSetTokenCommand };
