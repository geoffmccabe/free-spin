import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import http from "http";

dotenv.config();

const requiredEnv = [
  'DISCORD_APP_ID',
  'DISCORD_TOKEN',
  'DISCORD_GUILD',
  'API_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];
requiredEnv.forEach(key => {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
});

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(process.env.PORT || 8080);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const SPIN_CHANNEL_NAME = "🔄│free-spin";
let lastLeaderboardPost = "";

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error.message, error.stack);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  await client.destroy();
  process.exit(0);
});

(async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_APP_ID,
        process.env.DISCORD_GUILD,
      ),
      {
        body: [
          new SlashCommandBuilder()
            .setName("spin")
            .setDescription("Spin the wheel to win $HAROLD or other tokens"),
          new SlashCommandBuilder()
            .setName("freespin")
            .setDescription("Spin the wheel to win $HAROLD or other tokens"),
          new SlashCommandBuilder()
            .setName("dailyspin")
            .setDescription("Spin the wheel to win $HAROLD or other tokens"),
          new SlashCommandBuilder()
            .setName("mywallet")
            .setDescription("Link or view your Solana wallet address")
            .addStringOption(option =>
              option.setName("address")
                .setDescription("Your Solana wallet address (optional)")
                .setRequired(false)),
          new SlashCommandBuilder()
            .setName("addmywallet")
            .setDescription("Link or view your Solana wallet address")
            .addStringOption(option =>
              option.setName("address")
                .setDescription("Your Solana wallet address (optional)")
                .setRequired(false)),
          new SlashCommandBuilder()
            .setName("myaddr")
            .setDescription("Link or view your Solana wallet address")
            .addStringOption(option =>
              option.setName("address")
                .setDescription("Your Solana wallet address (optional)")
                .setRequired(false)),
          new SlashCommandBuilder()
            .setName("myaddress")
            .setDescription("Link or view your Solana wallet address")
            .addStringOption(option =>
              option.setName("address")
                .setDescription("Your Solana wallet address (optional)")
                .setRequired(false)),
          new SlashCommandBuilder()
            .setName("leaders")
            .setDescription("View the current leaderboard"),
          new SlashCommandBuilder()
            .setName("leaderboard")
            .setDescription("Alias for /leaders"),
          new SlashCommandBuilder()
            .setName("spinhelp")
            .setDescription("View available commands"),
        ],
      },
    );
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error('Failed to register slash commands:', error.message, error.stack);
    process.exit(1);
  }
})();

async function handleWalletCommand(user, channel, interaction, walletAddress) {
  try {
    const discord_id = user.id;
    console.log(`Processing wallet command for discord_id: ${discord_id}, address: ${walletAddress || 'none'}`);

    // Check if wallet is registered
    const { data: existingUser, error: userError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('discord_id', discord_id)
      .single();

    if (userError && userError.code !== 'PGRST116') {
      console.error(`User query error: ${userError.message}, code: ${userError.code}`);
      await interaction.editReply({ content: '❌ Database error querying user data. Contact support.', ephemeral: true });
      return;
    }

    // No address provided, show current wallet or prompt to link
    if (!walletAddress) {
      if (existingUser) {
        await interaction.editReply({ content: `Your current wallet is: ${existingUser.wallet_address}`, ephemeral: true });
      } else {
        await interaction.editReply({ content: '❌ No wallet linked. Use /mywallet <your_solana_address> to link one.', ephemeral: true });
      }
      return;
    }

    // Validate and update/link wallet
    const walletRegex = /^[A-HJ-NP-Za-km-z1-9]{43,44}$/;
    if (!walletRegex.test(walletAddress)) {
      await interaction.editReply({ content: '❌ Invalid Solana wallet address. Please provide a valid address.', ephemeral: true });
      return;
    }

    const { error: upsertError } = await supabase
      .from('users')
      .upsert({ discord_id, wallet_address: walletAddress });

    if (upsertError) {
      console.error(`Wallet upsert error: ${upsertError.message}, code: ${upsertError.code}`);
      await interaction.editReply({ content: '❌ Failed to save wallet due to database error. Contact support.', ephemeral: true });
      return;
    }

    const action = existingUser ? 'updated' : 'linked';
    await interaction.editReply({ content: `✅ Wallet ${action}: ${walletAddress}`, ephemeral: true });
  } catch (error) {
    console.error('handleWalletCommand error:', error.message, error.stack);
    await interaction.editReply({ content: '❌ Unexpected error processing wallet. Contact support.', ephemeral: true });
  }
}

async function handleVerifyCommand(user, channel, interaction) {
  try {
    const discord_id = user.id;
    console.log(`Processing spin for discord_id: ${discord_id}`);

    // Check if user has a registered wallet
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('discord_id', discord_id)
      .single();

    if (userError || !userData) {
      console.error(`User lookup error: ${userError?.message || 'No wallet found'}, code: ${userError?.code}`);
      await channel.send(`❌ <@${discord_id}> Please link your wallet first with /mywallet <your_solana_address>!`);
      if (interaction) {
        await interaction.editReply({ content: 'No wallet linked.', ephemeral: true });
      }
      return;
    }

    const wallet_address = userData.wallet_address;

    // Select a random active token from wheel_configurations
    const { data: tokens, error: tokenError } = await supabase
      .from('wheel_configurations')
      .select('contract_address')
      .eq('active', true);

    if (tokenError || !tokens || tokens.length === 0) {
      console.error(`Token query error: ${tokenError?.message || 'No active tokens found'}`);
      throw new Error('No active tokens available');
    }

    const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
    const contract_address = randomToken.contract_address;

    // Check daily spin limit per token
    const { data: limitRow, error: limitError } = await supabase
      .from('spin_limits')
      .select('daily_spin_limit')
      .eq('wallet_address', wallet_address)
      .single();

    const dailySpinLimit = limitRow?.daily_spin_limit || 1;

    const { data: recentSpins, error: spinError } = await supabase
      .from('daily_spins')
      .select('id')
      .eq('discord_id', discord_id)
      .eq('contract_address', contract_address)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(dailySpinLimit + 1);

    if (spinError) {
      console.error(`Spin check error: ${spinError.message}`);
      throw new Error(`Failed to check spin limit: ${spinError.message}`);
    }

    if (recentSpins.length >= dailySpinLimit) {
      await channel.send(`❌ <@${discord_id}> You've reached your daily spin limit for this token. Try again tomorrow!`);
      if (interaction) {
        await interaction.editReply({ content: 'Daily spin limit reached.', ephemeral: true });
      }
      return;
    }

    const { data: existing, error } = await supabase
      .from("spin_tokens")
      .select("*")
      .eq("discord_id", discord_id)
      .eq("used", false)
      .eq("contract_address", contract_address)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error(`Spin token query error: ${error.message}, code: ${error.code}`);
      throw new Error(`Database query failed: ${error.message}`);
    }

    let token = existing?.token;
    if (!token) {
      console.log(`Generating new token for ${discord_id}`);
      token = uuidv4();
      const { error: insertError } = await supabase
        .from("spin_tokens")
        .insert({ token, discord_id, wallet_address, contract_address });
      if (insertError) {
        console.error(`Token insert error: ${insertError.message}, code: ${insertError.code}`);
        throw new Error(`Failed to save token: ${insertError.message}`);
      }
    }

    const spinUrl = `${process.env.API_URL.replace("/api/spin", "")}/index.html?token=${token}`;
    console.log(`Generated spin URL: ${spinUrl}`);
    await channel.send(`🎯 <@${discord_id}> Click to spin the wheel:\n🔗 ${spinUrl}`);
    if (interaction) {
      await interaction.editReply({ content: 'Spin link sent!', ephemeral: true });
    }
  } catch (error) {
    console.error('handleVerifyCommand error:', error.message, error.stack);
    await channel.send('❌ Failed to generate spin link. Try again later.');
    if (interaction) {
      await interaction.editReply({ content: 'Error processing spin.', ephemeral: true });
    }
  }
}

async function fetchLeaderboardText() {
  try {
    const { data, error } = await supabase
      .rpc('fetch_leaderboard_text');

    if (error) {
      console.error(`Leaderboard error: ${error.message}, code: ${error.code}`);
      throw new Error(`Database error: ${error.message}`);
    }
    return data || 'No leaderboard data available.';
  } catch (error) {
    console.error('Leaderboard fetch error:', error.message);
    return 'Error fetching leaderboard.';
  }
}

client.on("messageCreate", async (message) => {
  if (
    message.author.bot ||
    !message.content.toLowerCase().startsWith("!verify")
  )
    return;
  if (message.channel.name !== SPIN_CHANNEL_NAME) return;
  await handleVerifyCommand(message.author, message.channel, null);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channel = interaction.channel;

  if (
    interaction.commandName === "spin" ||
    interaction.commandName === "freespin" ||
    interaction.commandName === "dailyspin"
  ) {
    if (channel.name !== SPIN_CHANNEL_NAME) {
      await interaction.reply({
        content: "Please use this command in #🔄-free-spin",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await handleVerifyCommand(interaction.user, channel, interaction);
  }

  if (
    interaction.commandName === "mywallet" ||
    interaction.commandName === "addmywallet" ||
    interaction.commandName === "myaddr" ||
    interaction.commandName === "myaddress"
  ) {
    const walletAddress = interaction.options.getString("address");
    await interaction.deferReply({ ephemeral: true });
    await handleWalletCommand(interaction.user, channel, interaction, walletAddress);
  }

  if (
    interaction.commandName === "leaders" ||
    interaction.commandName === "leaderboard"
  ) {
    await interaction.deferReply();
    const leaderboard = await fetchLeaderboardText();
    await interaction.editReply({
      content: `🏆 **Current Top 10 Winners:**\n\n${leaderboard}`,
    });
  }

  if (interaction.commandName === "spinhelp") {
    await interaction.deferReply({ ephemeral: true });
    const helpText = `
Available Commands:
- **/mywallet <address>**: Link your Solana wallet address.
- **/spin**: Spin the wheel to win $HAROLD or other tokens (in #🔄-free-spin).
- **/leaders**: View the current leaderboard.
    `;
    await interaction.editReply({ content: helpText });
  }
});

setInterval(
  async () => {
    try {
      const channel = client.channels.cache.find(
        (c) => c.name === SPIN_CHANNEL_NAME,
      );
      if (!channel || !channel.isTextBased()) return;

      const leaderboardText = await fetchLeaderboardText();
      if (leaderboardText !== lastLeaderboardPost) {
        channel.send(`🏆 **Updated Leaderboard:**\n\n${leaderboardText}`);
        lastLeaderboardPost = leaderboardText;
      }
    } catch (error) {
      console.error('Leaderboard post error:', error.message);
    }
  },
  60 * 60 * 1000,
);

(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log('Bot logged in successfully');
  } catch (error) {
    console.error('Discord login error:', error.message);
    process.exit(1);
  }
})();
