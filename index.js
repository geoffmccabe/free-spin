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

const server = http.createServer((req, res) => {
  console.log(`Health check received: ${req.url}`);
  res.writeHead(200);
  res.end('Bot is running');
}).listen(process.env.PORT || 8080, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 8080}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
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
  try {
    await client.destroy();
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } catch (err) {
    console.error('Error during shutdown:', err.message);
    process.exit(1);
  }
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
            .setDescription("View the current leaderboard (use /spinleaders instead)"),
          new SlashCommandBuilder()
            .setName("leaderboard")
            .setDescription("Alias for /leaders (use /spinleaders instead)"),
          new SlashCommandBuilder()
            .setName("spinleaders")
            .setDescription("View the current leaderboard"),
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

async function retryQuery(queryFn, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error) {
      console.error(`Query attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function handleWalletCommand(interaction, walletAddress) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const discord_id = interaction.user.id;
    console.log(`Processing wallet command for discord_id: ${discord_id}, address: ${walletAddress || 'none'}`);

    const { data: existingUser, error: userError } = await retryQuery(() =>
      supabase
        .from('users')
        .select('wallet_address')
        .eq('discord_id', discord_id)
        .single()
    );

    if (userError && userError.code !== 'PGRST116') {
      console.error(`User query error: ${userError.message}, code: ${userError.code}`);
      return interaction.editReply({ content: '❌ Database error querying user data. Please try again.', flags: 64 });
    }

    if (!walletAddress) {
      if (existingUser) {
        return interaction.editReply({ content: `Your current wallet is: \`${existingUser.wallet_address}\`\nTo update, use \`/mywallet <new_address>\`.`, flags: 64 });
      } else {
        return interaction.editReply({ content: '❌ No wallet linked. Use `/mywallet <your_solana_address>` to link one.', flags: 64 });
      }
    }

    const walletRegex = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
    if (!walletRegex.test(walletAddress)) {
      return interaction.editReply({ content: '❌ Invalid Solana wallet address.', flags: 64 });
    }

    const { error: upsertError } = await retryQuery(() =>
      supabase
        .from('users')
        .upsert({ discord_id, wallet_address: walletAddress }, { onConflict: 'discord_id' })
    );

    if (upsertError) {
      console.error(`Wallet upsert error: ${upsertError.message}, code: ${upsertError.code}`);
      return interaction.editReply({ content: '❌ Failed to save wallet due to database error.', flags: 64 });
    }

    const action = existingUser ? 'updated' : 'linked';
    await interaction.editReply({ content: `✅ Wallet ${action}: \`${walletAddress}\``, flags: 64 });
  } catch (error) {
    console.error('handleWalletCommand error:', error.message, error.stack);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An unexpected error occurred.', flags: 64 }).catch(err => console.error('Reply error:', err));
    } else if (!interaction.replied) {
      await interaction.editReply({ content: '❌ An unexpected error occurred.', flags: 64 }).catch(err => console.error('Edit reply error:', err));
    }
  }
}

async function handleVerifyCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
    const discord_id = interaction.user.id;
    console.log(`Processing spin for discord_id: ${discord_id}`);
    
    const { data: userData, error: userError } = await retryQuery(() =>
      supabase
        .from('users')
        .select('wallet_address')
        .eq('discord_id', discord_id)
        .single()
    );

    if (userError || !userData?.wallet_address) {
      console.error(`User query error: ${userError?.message || 'No wallet found'}, code: ${userError?.code || 'N/A'}`);
      return interaction.editReply({ content: `❌ Please link your wallet first with \`/mywallet <your_solana_address>\`!`, flags: 64 });
    }

    const wallet_address = userData.wallet_address;
    console.log(`Wallet for spin: ${wallet_address}`);

    const { data: tokens, error: tokenError } = await retryQuery(() =>
      supabase
        .from('wheel_configurations')
        .select('contract_address')
        .eq('active', true)
    );

    if (tokenError || !tokens || tokens.length === 0) {
      console.error(`Token query error: ${tokenError?.message || 'No tokens'}, code: ${tokenError?.code || 'N/A'}`);
      return interaction.editReply({ content: '❌ No active prize tokens available. Try again later.', flags: 64 });
    }

    const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
    const contract_address = randomToken.contract_address;
    console.log(`Selected token: ${contract_address}`);
    
    const { data: limitRow, error: limitError } = await retryQuery(() =>
      supabase
        .from('spin_limits')
        .select('daily_spin_limit')
        .eq('wallet_address', wallet_address)
        .single()
    );

    if (limitError && limitError.code !== 'PGRST116') {
      console.error(`Limit query error: ${limitError.message}, code: ${limitError.code}`);
      throw new Error(`Failed to check spin limit.`);
    }
    
    const dailySpinLimit = limitRow?.daily_spin_limit || 1;
    console.log(`Daily spin limit: ${dailySpinLimit}`);

    const { data: recentSpins, error: spinError } = await retryQuery(() =>
      supabase
        .from('daily_spins')
        .select('id', { count: 'exact' })
        .eq('discord_id', discord_id)
        .eq('contract_address', contract_address)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    );

    if (spinError) {
      console.error(`Spin query error: ${spinError.message}, code: ${spinError.code}`);
      throw new Error(`Failed to check recent spins.`);
    }

    if (recentSpins.length >= dailySpinLimit) {
      console.log(`Spin limit reached for discord_id: ${discord_id}`);
      return interaction.editReply({ content: `❌ You've reached your daily spin limit for this token. Try again tomorrow!`, flags: 64 });
    }

    const token = uuidv4();
    const { error: insertError } = await retryQuery(() =>
      supabase
        .from("spin_tokens")
        .insert({ token, discord_id, wallet_address, contract_address })
    );
      
    if (insertError) {
      console.error(`Token insert error: ${insertError.message}, code: ${insertError.code}`);
      throw new Error(`Failed to save spin token.`);
    }

    const spinUrl = `${process.env.API_URL.replace("/api/spin", "")}/index.html?token=${token}`;
    console.log(`Generated spin URL: ${spinUrl}`);
    
    await interaction.editReply({ content: `🎯 Click to spin the wheel:\n🔗 ${spinUrl}`, flags: 64 });

  } catch (error) {
    console.error(`handleVerifyCommand error for discord_id: ${discord_id}:`, error.message, error.stack);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Failed to generate spin link: ${error.message}`, flags: 64 }).catch(err => console.error('Reply error:', err));
    } else if (!interaction.replied) {
      await interaction.editReply({ content: `❌ Failed to generate spin link: ${error.message}`, flags: 64 }).catch(err => console.error('Edit reply error:', err));
    }
  }
}

async function fetchLeaderboardText() {
  try {
    const { data, error } = await retryQuery(() =>
      supabase.rpc('fetch_leaderboard_text')
    );
    if (error) {
      console.error(`Leaderboard query error: ${error.message}, code: ${error.code}`);
      throw error;
    }
    if (!data) return 'No leaderboard data available.';

    const lines = data.split('\n');
    const guild = client.guilds.cache.get(process.env.DISCORD_GUILD);
    if (!guild) {
      console.error('Guild not found for DISCORD_GUILD:', process.env.DISCORD_GUILD);
      return 'Error: Cannot find Discord server.';
    }

    const updatedLines = await Promise.all(lines.map(async (line) => {
      const parts = line.split(' ');
      const discord_id = parts.find(p => /^\d{17,19}$/.test(p));

      if (!discord_id) {
        console.log(`No discord_id found in line: ${line}`);
        return line;
      }

      try {
        const member = await guild.members.fetch(discord_id);
        const username = member.nickname || member.user.username;
        console.log(`Fetched username for discord_id: ${discord_id}: ${username}`);
        return line.replace(discord_id, username);
      } catch (err) {
        console.error(`Failed to fetch username for discord_id: ${discord_id}`, err);
        return line.replace(discord_id, `User_${discord_id.slice(-4)}`);
      }
    }));

    return updatedLines.join('\n') || 'No leaderboard data available.';
  } catch (error) {
    console.error('Leaderboard fetch error:', error.message, error.stack);
    return 'Error fetching leaderboard: ' + error.message;
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.toLowerCase().startsWith("!verify")) return;
  if (message.channel.name.toLowerCase() !== SPIN_CHANNEL_NAME.toLowerCase()) return;
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (["spin", "freespin", "dailyspin"].includes(interaction.commandName)) {
    console.log(`Received command: ${interaction.commandName}, channel: ${interaction.channel.name}`);
    if (interaction.channel.name.toLowerCase() !== SPIN_CHANNEL_NAME.toLowerCase()) {
      console.log(`Channel mismatch: expected ${SPIN_CHANNEL_NAME}, got ${interaction.channel.name}`);
      return interaction.reply({ content: `Please use this command in the #${SPIN_CHANNEL_NAME} channel.`, flags: 64 });
    }
    await handleVerifyCommand(interaction);
  }

  if (["mywallet", "addmywallet", "myaddr", "myaddress"].includes(interaction.commandName)) {
    const walletAddress = interaction.options.getString("address");
    await handleWalletCommand(interaction, walletAddress);
  }

  if (["leaders", "leaderboard", "spinleaders"].includes(interaction.commandName)) {
    await interaction.deferReply();
    const leaderboard = await fetchLeaderboardText();
    await interaction.editReply({ content: `🏆 **Current Top 10 Winners:**\n\n${leaderboard}` });
  }

  if (interaction.commandName === "spinhelp") {
    const helpText = "**/mywallet <address>**: Link your Solana wallet.\n**/spin**: Get a link to spin the wheel.\n**/spinleaders**: View the leaderboard.";
    await interaction.reply({ content: helpText, flags: 64 });
  }
});

setInterval(async () => {
  try {
    const channel = client.channels.cache.find(
      (c) => c.name.toLowerCase() === SPIN_CHANNEL_NAME.toLowerCase(),
    );
    if (!channel || !channel.isTextBased()) return;

    const leaderboardText = await fetchLeaderboardText();
    if (leaderboardText !== lastLeaderboardPost) {
      await channel.send(`🏆 **Updated Leaderboard:**\n\n${leaderboardText}`);
      lastLeaderboardPost = leaderboardText;
    }
  } catch (error) {
    console.error('Leaderboard post error:', error.message, error.stack);
  }
}, 60 * 60 * 1000);

(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log('Bot logged in successfully');
  } catch (error) {
    console.error('Discord login error:', error);
    process.exit(1);
  }
})();
