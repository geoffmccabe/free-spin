import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import http from "http";

dotenv.config();

// --- CONFIGURATION ---
const SPIN_CHANNEL_NAME = "🔄│free-spin";
const REQUIRED_ENV = ['DISCORD_APP_ID', 'DISCORD_TOKEN', 'DISCORD_GUILD', 'API_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
let lastLeaderboardPost = "";

// --- SETUP ---
REQUIRED_ENV.forEach(key => {
    if (!process.env[key]) {
        console.error(`Fatal: Missing environment variable ${key}`);
        process.exit(1);
    }
});

http.createServer((req, res) => res.writeHead(200).end('Bot is running')).listen(process.env.PORT || 8080);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- CORE LOGIC ---

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

async function handleSpinCommand(interaction) {
    const discord_id = interaction.user.id;
    console.log(`Processing /spin for user: ${discord_id}`);

    try {
        await interaction.deferReply({ ephemeral: true });

        // 1. Get user's registered wallet
        const { data: userData, error: userError } = await supabase.from('users').select('wallet_address').eq('discord_id', discord_id).single();
        if (userError || !userData?.wallet_address) {
            return interaction.editReply({ content: `❌ Please link your Solana wallet first using the \`/mywallet\` command.`, flags: 64 });
        }
        const wallet_address = userData.wallet_address;

        // 2. Get all active coins from the wheel configurations
        const { data: activeCoins, error: coinsError } = await supabase.from('wheel_configurations').select('contract_address, token_name').eq('active', true);
        if (coinsError || !activeCoins || activeCoins.length === 0) {
            console.error(`Coins query error: ${coinsError?.message || 'No active coins'}`);
            return interaction.editReply({ content: '❌ Sorry, there are no active spin wheels at the moment.', flags: 64 });
        }
        console.log(`Active coins: ${JSON.stringify(activeCoins)}`);

        // 3. Check spin limits for EACH coin
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const now = new Date().toISOString();
        const availableCoinsToSpin = [];

        for (const coin of activeCoins) {
            const { count, error: spinCountError } = await supabase.from('daily_spins')
                .select('*', { count: 'exact', head: true })
                .eq('discord_id', discord_id)
                .eq('contract_address', coin.contract_address)
                .gte('created_at', twentyFourHoursAgo)
                .lte('created_at', now);
            
            if (spinCountError) {
                console.error(`Spin count error for ${coin.token_name}: ${spinCountError.message}`);
                throw new Error(`Database error checking spin count for ${coin.token_name}.`);
            }

            console.log(`Spin count for ${coin.token_name} (contract: ${coin.contract_address}): ${count}`);
            if (count < 1) {
                availableCoinsToSpin.push(coin);
            }
        }

        // 4. If no available spins, inform the user
        if (availableCoinsToSpin.length === 0) {
            console.log(`User ${discord_id} has no available spins for any coin.`);
            return interaction.editReply({ content: "❌ You have already used your daily spin for all available wheels today. Please try again tomorrow.", flags: 64 });
        }

        // 5. Randomly select a coin
        const selectedCoin = availableCoinsToSpin[Math.floor(Math.random() * availableCoinsToSpin.length)];
        console.log(`Selected coin for spin: ${selectedCoin.token_name} (${selectedCoin.contract_address})`);

        // 6. Generate a unique spin token
        const spinToken = uuidv4();
        const { error: insertError } = await supabase.from("spin_tokens").insert({
            token: spinToken,
            discord_id: discord_id,
            wallet_address: wallet_address,
            contract_address: selectedCoin.contract_address
        });

        if (insertError) {
            console.error(`Token insert error: ${insertError.message}`);
            throw new Error("Failed to create a spin token in the database.");
        }

        const spinUrl = `${process.env.API_URL.replace("/api/spin", "")}/index.html?token=${spinToken}`;
        await interaction.editReply({ content: `✅ Your spin link for the **${selectedCoin.token_name}** wheel is ready!`, flags: 64 });
        await interaction.channel.send(`🎯 <@${discord_id}> Click to spin the wheel:\n🔗 ${spinUrl}`);

    } catch (error) {
        console.error("Error in handleSpinCommand:", error.message, error.stack);
        await interaction.editReply({ content: `❌ An unexpected error occurred: ${error.message}`, flags: 64 });
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

    console.log(`Raw leaderboard data: ${data}`);
    const lines = data.split('\n');
    const guild = client.guilds.cache.get(process.env.DISCORD_GUILD);
    if (!guild) {
      console.error('Guild not found for DISCORD_GUILD:', process.env.DISCORD_GUILD);
      return 'Error: Cannot find Discord server.';
    }

    const updatedLines = await Promise.all(lines.map(async (line) => {
      const match = line.match(/: (\d{17,19}) —/);
      if (!match) {
        console.log(`No discord_id match in line: ${line}`);
        const walletMatch = line.match(/: ([A-HJ-NP-Za-km-z1-9]{32,44}) —/);
        if (walletMatch) {
          const wallet = walletMatch[1];
          const { data: userData, error: userError } = await supabase
            .from('users')
            .select('discord_id')
            .eq('wallet_address', wallet)
            .single();
          if (userError || !userData) {
            console.error(`No discord_id for wallet: ${wallet}`);
            return line.replace(wallet, `User_${wallet.slice(-4)}`);
          }
          try {
            const member = await guild.members.fetch(userData.discord_id);
            const username = member.nickname || member.user.username;
            console.log(`Mapped wallet ${wallet} to discord_id: ${userData.discord_id}, username: ${username}`);
            return line.replace(wallet, username);
          } catch (err) {
            console.error(`Failed to fetch username for discord_id: ${userData.discord_id}`, err);
            return line.replace(wallet, `User_${userData.discord_id.slice(-4)}`);
          }
        }
        return line;
      }

      const discord_id = match[1];
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

// --- DISCORD EVENT HANDLERS ---

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
    await handleSpinCommand(interaction);
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

// --- STARTUP ---
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

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log('Bot logged in successfully');
  } catch (error) {
    console.error('Discord login error:', error);
    process.exit(1);
  }
})();
