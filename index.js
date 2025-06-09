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
            .setDescription("Spin the wheel to win $HAROLD tokens"),
          new SlashCommandBuilder()
            .setName("freespin")
            .setDescription("Spin the wheel to win $HAROLD tokens"),
          new SlashCommandBuilder()
            .setName("dailyspin")
            .setDescription("Spin the wheel to win $HAROLD tokens"),
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

async function handleVerifyCommand(user, channel, interaction) {
  try {
    const discord_id = user.id;
    console.log(`Processing spin for discord_id: ${discord_id}`);

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('discord_id', discord_id)
      .single();

    if (userError) {
      console.error(`User lookup error: ${userError.message}, code: ${userError.code}`);
      throw new Error(`Database error: ${userError.message}`);
    }
    if (!userData) {
      console.error(`No user found for discord_id: ${discord_id}`);
      throw new Error('User not registered. Please verify your wallet.');
    }

    const wallet_address = userData.wallet_address;

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
    await channel.send(`🎯 <@${discord_id}> Click to spin the wheel:\n🔗 ${spinUrl}`);
  } catch (error) {
    console.error('handleVerifyCommand error:', error.message, error.stack);
    await channel.send('❌ Failed to generate spin link. Try again later.');
    if (interaction) {
      await interaction.followUp({ content: 'Error processing spin.', ephemeral: true });
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
