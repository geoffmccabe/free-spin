import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

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

// Slash Command Registration
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

async function handleVerifyCommand(user, channel) {
  const discord_id = user.id;
  const { data: existing, error } = await supabase
    .from("spin_tokens")
    .select("*")
    .eq("discord_id", discord_id)
    .eq("used", false)
    .single();

  let token = existing?.token;

  if (!token) {
    token = uuidv4();
    await supabase.from("spin_tokens").insert({ token, discord_id });
  }

  const spinUrl = `${process.env.API_URL.replace("/api/spin", "")}/spin.html?token=${token}`;
  channel.send(`🎯 <@${discord_id}> Click to spin the wheel:\n🔗 ${spinUrl}`);
}

async function fetchLeaderboardText() {
  const { data, error } = await supabase
    .from("wallet_totals")
    .select("*")
    .order("total", { ascending: false })
    .limit(10);

  if (error || !data) return "Error fetching leaderboard.";

  return data
    .map(
      (entry, i) =>
        `#${i + 1}: ${entry.wallet_address} — ${entry.total} $HAROLD`,
    )
    .join("\n");
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
    const channel = client.channels.cache.find(
      (c) => c.name === SPIN_CHANNEL_NAME,
    );
    if (!channel || !channel.isTextBased()) return;

    const leaderboardText = await fetchLeaderboardText();
    if (leaderboardText !== lastLeaderboardPost) {
      channel.send(`🏆 **Updated Leaderboard:**\n\n${leaderboardText}`);
      lastLeaderboardPost = leaderboardText;
    }
  },
  60 * 60 * 1000,
); // Every hour

client.login(process.env.DISCORD_TOKEN);
