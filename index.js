import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import { Connection } from '@solana/web3.js';
import { createHmac, randomUUID } from 'crypto';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SPIN_CHANNEL_NAME = "🔄│free-spin";
const LEADERBOARD_CHANNEL_NAME = "🏆│spin-leaderboard";
const SPIN_URL = process.env.SPIN_URL || 'https://solspin.lightningworks.io';
const DEFAULT_TOKEN_ADDRESS = '3vgopg7xm3EWkXfxmWPUpcf7g939hecfqg18sLuXDzVt'; // $HAROLD

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const solanaConnection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

async function retryQuery(queryFn, maxRetries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function handleSpinCommand(interaction) {
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
    { data: adminData, error: adminError }
  ] = await Promise.all([
    retryQuery(() => supabase.from('users').select('wallet_address, spin_limit').eq('discord_id', discord_id).single()),
    retryQuery(() => supabase.from('server_tokens').select('contract_address').eq('server_id', server_id)),
    retryQuery(() => supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single())
  ]);

  if (userError || !userData?.wallet_address) {
    console.error(`User query error: ${userError?.message || 'No wallet found'}`);
    return interaction.editReply({ content: `❌ Please link your Solana wallet first using the \`/mywallet\` command.`, flags: 64 });
  }

  const isSuperadmin = adminData?.role === 'superadmin';
  console.log(`Admin check: ${discord_id} is ${isSuperadmin ? '' : 'not '}superadmin`);

  let contract_addresses = serverTokens?.map(t => t.contract_address) || [];
  if (contract_addresses.length === 0) {
    contract_addresses = [DEFAULT_TOKEN_ADDRESS];
    console.log(`No server-specific tokens for server ${server_id}, using default: ${contract_addresses[0]}`);
  } else {
    console.log(`Server tokens: ${contract_addresses.join(', ')}`);
  }

  const { data: coinData, error: coinError } = await retryQuery(() =>
    supabase.from('wheel_configurations').select('contract_address, token_name').in('contract_address', contract_addresses)
  );
  if (coinError || !coinData?.length) {
    console.error(`Coin query error: ${coinError?.message || 'No coins found'}`);
    return interaction.editReply({ content: `❌ No active coins available for spinning on this server.`, flags: 64 });
  }
  console.log(`Available coins: ${JSON.stringify(coinData)}`);

  const availableCoinsToSpin = [];
  let spinsLeft = userData.spin_limit;
  if (!isSuperadmin) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSpins, error: spinCountError } = await retryQuery(() =>
      supabase.from('daily_spins')
        .select('contract_address')
        .eq('discord_id', discord_id)
        .gte('created_at', twentyFourHoursAgo)
    );
    if (spinCountError) {
      console.error(`Spin count error: ${spinCountError.message}`);
      return interaction.editReply({ content: `❌ Database error checking spin count.`, flags: 64 });
    }
    const totalSpinsToday = recentSpins.length;
    spinsLeft = Math.max(0, userData.spin_limit - totalSpinsToday);
    if (totalSpinsToday >= userData.spin_limit) {
      console.log(`Spin limit exceeded for discord_id: ${discord_id}`);
      return interaction.editReply({ content: `❌ You have used all your ${userData.spin_limit} daily spins. Try again tomorrow!`, flags: 64 });
    }
    const spunContracts = recentSpins.map(s => s.contract_address);
    for (const coin of coinData) {
      if (!spunContracts.includes(coin.contract_address)) {
        availableCoinsToSpin.push(coin);
      }
    }
    console.log(`Available coins to spin: ${JSON.stringify(availableCoinsToSpin)}`);
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

  const coin = availableCoinsToSpin[Math.floor(Math.random() * availableCoinsToSpin.length)];
  console.log(`Selected coin for spin: ${coin.token_name} (${coin.contract_address})`);

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
    }).select('token').single()
  );
  if (tokenError) {
    console.error(`Token insert error: ${tokenError.message}`);
    return interaction.editReply({ content: `❌ Failed to generate spin token.`, flags: 64 });
  }
  console.log(`Inserting spin token: ${tokenData.token}`);

  const spinUrl = `${SPIN_URL}/index.html?token=${tokenData.token}&server_id=${server_id}`;
  const spinsLeftText = typeof spinsLeft === 'number' ? `${spinsLeft} spin${spinsLeft === 1 ? '' : 's'} left today` : 'Unlimited spins';
  console.log(`Sending spin URL: ${spinUrl}`);
  return interaction.editReply({ content: `Your spin is ready! Click here: ${spinUrl}\n${spinsLeftText}`, flags: 64 });
}

async function handleWalletCommand(interaction) {
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
      supabase.from('users').upsert({ discord_id, wallet_address, spin_limit: 1 }).select('wallet_address').single()
    );
    if (error) {
      console.error(`Wallet upsert error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to save wallet address.`, flags: 64 });
    }
    console.log(`Wallet saved: ${data.wallet_address}`);
    return interaction.editReply({ content: `✅ Wallet address saved: \`${data.wallet_address}\``, flags: 64 });
  } else {
    const { data, error } = await retryQuery(() =>
      supabase.from('users').select('wallet_address').eq('discord_id', discord_id).single()
    );
    if (error || !data?.wallet_address) {
      console.error(`Wallet query error: ${error?.message || 'No wallet found'}`);
      return interaction.editReply({ content: `❌ No wallet address found. Please provide one using \`/mywallet <address>\`.`, flags: 64 });
    }
    console.log(`Wallet retrieved: ${data.wallet_address}`);
    return interaction.editReply({ content: `ℹ️ Your wallet address: \`${data.wallet_address}\``, flags: 64 });
  }
}

async function handleLeaderboardCommand(interaction) {
  console.log(`Processing leaderboard command in channel: ${interaction.channel.name}`);
  try {
    await interaction.deferReply();
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return interaction.reply({ content: `❌ Failed to reply: ${error.message}`, flags: 64 });
  }

  try {
    const { data, error } = await retryQuery(() =>
      supabase.rpc('fetch_leaderboard_text')
    );
    if (error || !data) {
      console.error(`Leaderboard query error: ${error?.message || 'No data returned'}`);
      return interaction.editReply({ content: `❌ Failed to fetch leaderboard: ${error?.message || 'Unknown error'}`, flags: 64 });
    }
    console.log(`Leaderboard data: ${data}`);

    let leaderboard_text = '';
    const rows = data.split('\n').filter(row => row.trim());
    for (const row of rows) {
      const match = row.match(/^#(\d+): (\d+) — (\d+) (.+)$/);
      if (!match) continue;
      const [, rank, discord_id, total_amount, token_name] = match;
      try {
        const user = await client.users.fetch(discord_id);
        leaderboard_text += `#${rank}: ${user.username} — ${total_amount} ${token_name}\n`;
      } catch (fetchError) {
        console.error(`Failed to fetch user ${discord_id}: ${fetchError.message}`);
        leaderboard_text += row + '\n';
      }
    }

    if (!leaderboard_text) {
      leaderboard_text = 'No spins recorded in the last 30 days.';
    }

    return interaction.editReply({ content: leaderboard_text, flags: 64 });
  } catch (err) {
    console.error(`Leaderboard command error: ${err.message}`);
    return interaction.editReply({ content: `❌ Failed to fetch leaderboard: ${err.message}`, flags: 64 });
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
- **/spin**: Spin the wheel to win $HAROLD or other tokens (limited daily).
- **/mywallet [address]**: Link or view your Solana wallet address.
- **/spinleaders**: View the current leaderboard.
- **/spinhelp**: Show this help message.
- **/settoken <contract_address> [remove]**: (Admins only) Add or remove a token for this server.
  `;
  return interaction.editReply({ content: helpText, flags: 64 });
}

async function handleSetTokenCommand(interaction) {
  const discord_id = interaction.user.id;
  const server_id = interaction.guildId;
  const contract_address = interaction.options.getString('contract_address');
  const remove = interaction.options.getBoolean('remove') || false;
  console.log(`Processing /settoken for user: ${discord_id}, server: ${server_id}, contract: ${contract_address}, remove: ${remove}`);

  try {
    await interaction.deferReply({ flags: 64 });
  } catch (error) {
    console.error(`Defer reply failed: ${error.message}`);
    return;
  }

  const { data: adminData, error: adminError } = await retryQuery(() =>
    supabase.from('server_admins').select('role').eq('server_id', server_id).eq('discord_id', discord_id).single()
  );
  if (adminError || !adminData || !['superadmin', 'admin'].includes(adminData.role)) {
    console.error(`Permission denied for user: ${discord_id}, error: ${adminError?.message || 'Not admin'}`);
    return interaction.editReply({ content: `❌ You need superadmin or admin role to use this command.`, flags: 64 });
  }
  console.log(`Admin role verified: ${adminData.role}`);

  if (!contract_address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
    return interaction.editReply({ content: `❌ Invalid contract address.`, flags: 64 });
  }

  const { data: configData, error: configError } = await retryQuery(() =>
    supabase.from('wheel_configurations').select('token_name').eq('contract_address', contract_address).single()
  );
  if (configError || !configData) {
    console.error(`Config error: ${configError?.message || 'No config found'}`);
    return interaction.editReply({ content: `❌ Invalid token: Not configured in the system.`, flags: 64 });
  }
  console.log(`Token verified: ${configData.token_name}`);

  if (remove) {
    const { error } = await retryQuery(() =>
      supabase.from('server_tokens').delete().eq('server_id', server_id).eq('contract_address', contract_address)
    );
    if (error) {
      console.error(`Token delete error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to remove token.`, flags: 64 });
    }
    console.log(`Token removed: ${contract_address}`);
    return interaction.editReply({ content: `✅ Token ${configData.token_name} removed from this server.`, flags: 64 });
  } else {
    const { data, error } = await retryQuery(() =>
      supabase.from('server_tokens').upsert({ server_id, contract_address }).select('contract_address').single()
    );
    if (error) {
      console.error(`Token insert error: ${error.message}`);
      return interaction.editReply({ content: `❌ Failed to add token.`, flags: 64 });
    }
    console.log(`Token added: ${data.contract_address}`);
    return interaction.editReply({ content: `✅ Token ${configData.token_name} added to this server.`, flags: 64 });
  }
}

client.once('ready', async () => {
  console.log('Bot logged in successfully');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('Registering global slash commands');
    await rest.put(
      Routes.applicationCommands(DISCORD_APP_ID),
      { body: [
        new SlashCommandBuilder().setName("spin").setDescription("Spin the wheel to win $HAROLD or other tokens"),
        new SlashCommandBuilder().setName("freespin").setDescription("Spin the wheel to win $HAROLD or other tokens"),
        new SlashCommandBuilder().setName("dailyspin").setDescription("Spin the wheel to win $HAROLD or other tokens"),
        new SlashCommandBuilder().setName("mywallet").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("addmywallet").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("myaddr").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("myaddress").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("leaders").setDescription("View the current leaderboard"),
        new SlashCommandBuilder().setName("leaderboard").setDescription("Alias for /leaders"),
        new SlashCommandBuilder().setName("spinleaders").setDescription("View the current leaderboard"),
        new SlashCommandBuilder().setName("spinhelp").setDescription("View available commands"),
        new SlashCommandBuilder().setName("settoken").setDescription("Add or remove a token for this server (admin only)")
          .addStringOption(option => option.setName("contract_address").setDescription("Token contract address").setRequired(true))
          .addBooleanOption(option => option.setName("remove").setDescription("Remove the token instead of adding").setRequired(false)),
      ] }
    );
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error(`Error registering slash commands: ${error.message}`);
  }

  setInterval(async () => {
    const leaderboardChannel = client.channels.cache.find(channel =>
      channel.name.toLowerCase() === LEADERBOARD_CHANNEL_NAME.toLowerCase() && channel.isTextBased()
    );
    if (leaderboardChannel) {
      try {
        const { data, error } = await retryQuery(() => supabase.rpc('fetch_leaderboard_text'));
        if (error) {
          console.error(`Leaderboard interval error: ${error.message}`);
          return;
        }
        console.log(`Posting leaderboard: ${data}`);
        await leaderboardChannel.send(data);
      } catch (error) {
        console.error(`Error posting leaderboard: ${error.message}`);
      }
    } else {
      console.log(`Leaderboard channel not found: ${LEADERBOARD_CHANNEL_NAME}`);
    }
  }, 60 * 60 * 1000);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log(`Received command: ${interaction.commandName}, channel: ${interaction.channel.name}`);

  if (["spin", "freespin", "dailyspin"].includes(interaction.commandName)) {
    if (interaction.channel.name.toLowerCase() !== SPIN_CHANNEL_NAME.toLowerCase()) {
      console.log(`Channel mismatch: expected ${SPIN_CHANNEL_NAME}, got ${interaction.channel.name}`);
      return interaction.reply({ content: `Please use this command in the #${SPIN_CHANNEL_NAME} channel.`, flags: 64 });
    }
    await handleSpinCommand(interaction);
  } else if (["mywallet", "addmywallet", "myaddr", "myaddress"].includes(interaction.commandName)) {
    await handleWalletCommand(interaction);
  } else if (["leaders", "leaderboard", "spinleaders"].includes(interaction.commandName)) {
    await handleLeaderboardCommand(interaction);
  } else if (interaction.commandName === "spinhelp") {
    await handleHelpCommand(interaction);
  } else if (interaction.commandName === "settoken") {
    await handleSetTokenCommand(interaction);
  }
});

client.login(DISCORD_TOKEN);
