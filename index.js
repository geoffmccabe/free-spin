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

  // Validate environment variables
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

  // Minimal HTTP server for Railway
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

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error.message, error.stack);
  });

  // Handle SIGTERM for graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
  });

  // Slash Command Registration
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
              .setDescription("Spin the wheel or get your spin link"),
            new SlashCommandBuilder()
              .setName("freespin")
              .setDescription("Spin the wheel or get your spin link"),
            new SlashCommandBuilder()
              .setName("dailyspin")
              .setDescription("Spin the wheel or get your spin link"),
            new SlashCommandBuilder()
              .setName("leaders")
              .setDescription("View the current leaderboard"),
            new SlashCommandBuilder()
              .setName("leaderboard")
              .setDescription("Alias for /leaders"),
          ],
        },
      );
      console.log('Slash commands registered successfully');
    } catch (error) {
      console.error('Failed to register slash commands:', error.message, error.stack);
      process.exit(1);
    }
  })();

  async function handleVerifyCommand(user, channel) {
    try {
      const discord_id = user.id;
      console.log(`Processing spin for discord_id: ${discord_id}`);

      // Check if user exists in users table
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('wallet_address')
        .eq('discord_id', discord_id)
        .single();

      if (userError || !userData) {
        console.error(`User lookup error: ${userError?.message || 'No user found'}`);
        throw new Error('User not registered. Please verify your wallet.');
      }

      const wallet_address = userData.wallet_address;

      // Check for existing spin token
      const { data: existing, error } = await supabase
        .from("spin_tokens")
        .select("*")
        .eq("discord_id", discord_id)
        .eq("used", false)
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
          .insert({ token, discord_id, wallet_address });
        if (insertError) {
          console.error(`Token insert error: ${insertError.message}, code: ${insertError.code}`);
          throw new Error(`Failed to save token: ${insertError.message}`);
        }
      }

      const spinUrl = `${process.env.API_URL.replace("/api/spin", "")}/index.html?token=${token}`;
      console.log(`Generated spin URL: ${spinUrl}`);
      channel.send(`🎯 <@${discord_id}> Click to spin the wheel:\n🔗 ${spinUrl}`);
    } catch (error) {
      console.error('handleVerifyCommand error:', error.message, error.stack);
      channel.send('❌ Failed to generate spin link. Try again later.');
    }
  }

  async function fetchLeaderboardText() {
    try {
      const { data, error } = await supabase
        .from("wallet_totals")
        .select("*")
        .order("total", { ascending: false })
        .limit(10);

      if (error) {
        console.error(`Leaderboard error: ${error.message}, code: ${error.code}`);
        throw new Error(`Database error: ${error.message}`);
      }
      if (!data) return "Error fetching leaderboard.";

      return data
        .map(
          (entry, i) =>
            `#${i + 1}: ${entry.wallet_address} — ${entry.total} $HAROLD`,
        )
        .join("\n");
    } catch (error) {
      console.error('Leaderboard fetch error:', error.message);
      return "Error fetching leaderboard.";
    }
  }

  client.on("messageCreate", async (message) => {
    if (
      message.author.bot ||
      !message.content.toLowerCase().startsWith("!verify")
    )
      return;
    if (message.channel.name !== SPIN_CHANNEL_NAME) return;
    await handleVerifyCommand(message.author, message.channel);
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
      await handleVerifyCommand(interaction.user, channel);
      await interaction.editReply({ content: "Spin link sent!" });
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
  });

  // Auto leaderboard posting hourly
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

  // Login to Discord
  (async () => {
    try {
      await client.login(process.env.DISCORD_TOKEN);
      console.log('Bot logged in successfully');
    } catch (error) {
      console.error('Discord login error:', error.message, error.stack);
      process.exit(1);
    }
  })();
