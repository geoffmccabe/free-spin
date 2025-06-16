import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import { Connection } from '@solana/web3.js';
import { randomUUID } from 'crypto';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SPIN_CHANNEL_NAME = "🔄│free-spin";
const LEADERBOARD_CHANNEL_NAME = "🏆│spin-leaderboard";
const SPIN_URL = process.env.SPIN_URL || 'https://solspin.lightningworks.io';

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
  console.log(`Processing /spin for user: ${discord_id}`);
  await interaction.deferReply({ flags: 64 });
  console.log('Deferred reply sent');

  const { data: userData, error: userError } = await retryQuery(() =>
    supabase.from('users').select('wallet_address').eq('discord_id', discord_id).single()
  );
  if (userError || !userData?.wallet_address) {
    console.error(`User query error: ${userError?.message || 'No wallet found'}`);
    return interaction.editReply({ content: `❌ Please link your Solana wallet first using the \`/mywallet\` command.`, flags: 64 });
  }
  console.log(`Wallet found: ${userData.wallet_address}`);

  const { data: activeCoins, error: coinsError } = await retryQuery(() =>
    supabase.from('wheel_configurations').select('contract_address, token_name').eq('active', true)
  );
  if (coinsError || !activeCoins?.length) {
    console.error(`Coins query error: ${coinsError?.message || 'No active coins found'}`);
    return interaction.editReply({ content: `❌ No active coins available for spinning.`, flags: 64 });
  }
  console.log(`Active coins: ${JSON.stringify(activeCoins)}`);

  const availableCoinsToSpin = [];
  if (discord_id !== '332676096531103775') {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    for (const coin of activeCoins) {
      const { count, error } = await retryQuery(() =>
        supabase.from('daily_spins')
          .select('*', { count: 'exact', head: true })
          .eq('discord_id', discord_id)
          .eq('contract_address', coin.contract_address)
          .gte('created_at', twentyFourHoursAgo)
          .lte('created_at', now)
      );
      if (error) {
        console.error(`Spin count error: ${error.message}`);
        return interaction.editReply({ content: `❌ Database error checking spin count.`, flags: 64 });
      }
      if (count < 1) {
        availableCoinsToSpin.push(coin);
      }
    }
    console.log(`Available coins to spin: ${JSON.stringify(availableCoinsToSpin)}`);
    if (!availableCoinsToSpin.length) {
      return interaction.editReply({ content: `❌ You have already used your daily spin for all available coins. Try again tomorrow!`, flags: 64 });
    }
  } else {
    console.log(`Bypassing spin limit for discord_id: ${discord_id}`);
    availableCoinsToSpin.push(...activeCoins);
  }

  const coin = availableCoinsToSpin[Math.floor(Math.random() * availableCoinsToSpin.length)];
  console.log(`Selected coin for spin: ${coin.token_name} (${coin.contract_address})`);

  const { data: tokenData, error: tokenError } = await retryQuery(() =>
    supabase.from('spin_tokens').insert({
      discord_id: discord_id,
      wallet_address: userData.wallet_address,
      contract_address: coin.contract_address,
      token: randomUUID(),
      used: false
    }).select('token').single()
  );
  if (tokenError) {
    console.error(`Token insert error: ${tokenError.message}`);
    return interaction.editReply({ content: `❌ Failed to generate spin token.`, flags: 64 });
  }
  console.log(`Inserting spin token: ${tokenData.token}`);

  const spinUrl = `${SPIN_URL}/index.html?token=${tokenData.token}`;
  console.log(`Sending spin URL: ${spinUrl}`);
  return interaction.editReply({ content: `🎰 Your spin is ready! Click here: ${spinUrl}`, flags: 64 });
}

async function handleWalletCommand(interaction) {
  const discord_id = interaction.user.id;
  const wallet_address = interaction.options.getString('address');
  console.log(`Processing wallet command for user: ${discord_id}, address: ${wallet_address}`);

  await interaction.deferReply({ flags: 64 });

  if (wallet_address) {
    if (!wallet_address.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      return interaction.editReply({ content: `❌ Invalid Solana wallet address.`, flags: 64 });
    }

    const { data, error } = await retryQuery(() =>
      supabase.from('users').upsert({ discord_id, wallet_address }).select('wallet_address').single()
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
    if (error || !userData?.wallet_address) {
      console.error(`User query error: ${error?.message || 'No wallet found'}`);
      return interaction.editReply({ content: `❌ Please link your Solana wallet first using the \`/mywallet\` command.`, flags: 64 });
    }
    console.log(`Wallet found: ${userData.wallet_address}`);
    return interaction.editReply({ content: `ℹ️ Your wallet address: \`${userData.wallet_address}\``, flags: 64 });
  }
}

async function handleLeaderboardCommand(interaction) {
  console.log(`Processing leaderboard command in channel: ${interaction.channel.name}`);
  await interaction.deferReply();

  const { data, error } = await retryQuery(() =>
    supabase.rpc('fetch_leaderboard_text')
  );
  if (error || !data) {
    console.error(`Leaderboard query error: ${error?.message || 'No data returned'}`);
    return interaction.editReply({ content: `❌ Failed to fetch leaderboard.`, flags: 64 });
  }
  console.log(`Leaderboard data: ${data}`);

  let leaderboard_text = '';
  const rows = data.split('\n').filter(row => row.trim());
  let rank = 1;
  let prev_rank = 0;

  for (const row of rows) {
    const match = row.match(/^(\d+),(\d+)$/);
    if (!match) continue;
    const [, discord_id, total_amount] = match;
    try {
      const user = await client.users.fetch(discord_id);
      const username = user.username || `User_${discord_id}`; // Fix: Use username
      leaderboard_text += `#${rank}: ${username} — ${total_amount} $HAROLD\n`;
      prev_rank = rank;
      rank++;
    } catch (fetchError) {
      console.error(`Failed to fetch user ${discord_id}: ${fetchError.message}`);
      leaderboard_text += `#${rank}: User_${discord_id} — ${total_amount} $HAROLD\n`;
      rank++;
    }
  }

  if (!leaderboard_text) {
    leaderboard_text = 'No spins recorded in the last 30 days.';
  }

  return interaction.editReply({ content: leaderboard_text, flags: 64 });
}

async function handleHelpCommand(interaction) {
  console.log(`Processing help command`);
  await interaction.deferReply({ flags: 64 });

  const helpText = `
**Free Spin Bot Commands**
- **/spin**: Spin the wheel to win $HAROLD or other tokens (once per day).
- **/freespin**: Alias for /spin.
- **/dailyspin**: Alias for /spin.
- **/mywallet [address]**: Link or view your Solana wallet address.
- **/addmywallet [address]**: Alias for /mywallet.
- **/myaddr [address]**: Alias for /mywallet.
- **/myaddress [address]**: Alias for /mywallet.
- **/spinleaders**: View the current leaderboard.
- **/leaders**: Alias for /spinleaders.
- **/leaderboard**: Alias for /spinleaders.
- **/spinhelp**: Show this help message.
  `;
  return interaction.editReply({ content: helpText, flags: 64 });
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
  }
});

client.login(DISCORD_TOKEN);
