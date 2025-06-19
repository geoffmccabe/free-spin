import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import { Connection } from '@solana/web3.js';
import { handleLeaderboardCommand } from './leaderboards.js';
import { handleSpinCommand, handleWalletCommand, handleSetTokenCommand, handleHelpCommand } from './commands.js';

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

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (['spin', 'freespin', 'dailyspin', 'leaders', 'leaderboard', 'spinleaders'].includes(interaction.commandName)) {
      const server_id = interaction.guildId;
      try {
        const { data: serverTokens } = await retryQuery(() =>
          supabase.from('server_tokens').select('contract_address, default_token').eq('server_id', server_id)
        );
        const contract_addresses = serverTokens?.map(t => t.contract_address) || [DEFAULT_TOKEN_ADDRESS];
        const { data: coinData } = await retryQuery(() =>
          supabase.from('wheel_configurations').select('contract_address, token_name').in('contract_address', contract_addresses)
        );
        const default_token = serverTokens?.find(t => t.default_token)?.contract_address;
        const choices = coinData?.map(c => ({
          name: c.token_name,
          value: c.token_name
        })) || [{ name: '$HAROLD', value: '$HAROLD' }];
        if (default_token) {
          const defaultCoin = coinData?.find(c => c.contract_address === default_token);
          if (defaultCoin) {
            choices.sort((a, b) => (a.value === defaultCoin.token_name ? -1 : 1));
          }
        }
        await interaction.respond(choices.slice(0, 25));
      } catch (error) {
        console.error(`Autocomplete error: ${error.message}`);
        await interaction.respond([]);
      }
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  console.log(`Received command: ${interaction.commandName}, channel: ${interaction.channel.name}`);

  if (["spin", "freespin", "dailyspin"].includes(interaction.commandName)) {
    if (interaction.channel.name.toLowerCase() !== SPIN_CHANNEL_NAME.toLowerCase()) {
      console.log(`Channel mismatch: expected ${SPIN_CHANNEL_NAME}, got ${interaction.channel.name}`);
      return interaction.reply({ content: `Please use this command in the #${SPIN_CHANNEL_NAME} channel.`, flags: 64 });
    }
    await handleSpinCommand(interaction, supabase, retryQuery);
  } else if (["mywallet", "addmywallet", "myaddr", "myaddress"].includes(interaction.commandName)) {
    await handleWalletCommand(interaction, supabase, retryQuery);
  } else if (["leaders", "leaderboard", "spinleaders"].includes(interaction.commandName)) {
    await handleLeaderboardCommand(interaction, client, supabase, retryQuery);
  } else if (interaction.commandName === "spinhelp") {
    await handleHelpCommand(interaction);
  } else if (interaction.commandName === "settoken") {
    await handleSetTokenCommand(interaction, supabase, retryQuery);
  }
});

client.once('ready', async () => {
  console.log('Bot logged in successfully');

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    console.log('Registering global slash commands');
    await rest.put(
      Routes.applicationCommands(DISCORD_APP_ID),
      { body: [
        new SlashCommandBuilder().setName("spin").setDescription("Spin the wheel to win $HAROLD or other tokens")
          .addStringOption(option => 
            option.setName("token_name")
              .setDescription("Choose a token to spin")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("freespin").setDescription("Spin the wheel to win $HAROLD or other tokens")
          .addStringOption(option => 
            option.setName("token_name")
              .setDescription("Choose a token to spin")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("dailyspin").setDescription("Spin the wheel to win $HAROLD or other tokens")
          .addStringOption(option => 
            option.setName("token_name")
              .setDescription("Choose a token to spin")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("mywallet").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("addmywallet").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("myaddr").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("myaddress").setDescription("Link or view your Solana wallet address")
          .addStringOption(option => option.setName("address").setDescription("Your Solana wallet address (optional)").setRequired(false)),
        new SlashCommandBuilder().setName("leaders").setDescription("View the current leaderboard")
          .addStringOption(option =>
            option.setName("token_name")
              .setDescription("Choose a token to view its leaderboard")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("leaderboard").setDescription("Alias for /leaders")
          .addStringOption(option =>
            option.setName("token_name")
              .setDescription("Choose a token to view its leaderboard")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("spinleaders").setDescription("View the current leaderboard")
          .addStringOption(option =>
            option.setName("token_name")
              .setDescription("Choose a token to view its leaderboard")
              .setRequired(false)
              .setAutocomplete(true)
          ),
        new SlashCommandBuilder().setName("spinhelp").setDescription("View available commands"),
        new SlashCommandBuilder().setName("settoken").setDescription("Add or remove a token for this server (superadmin only)")
          .addStringOption(option => option.setName("contract_address").setDescription("Token contract address").setRequired(true))
          .addBooleanOption(option => option.setName("remove").setDescription("Remove the token").setRequired(false))
          .addBooleanOption(option => option.setName("default").setDescription("Set as default token").setRequired(false)),
      ] }
    );
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error(`Error registering slash commands: ${error.message}`);
  }
});

export {
  client,
  supabase,
  retryQuery,
  LEADERBOARD_CHANNEL_NAME,
  SPIN_CHANNEL_NAME,
  SPIN_URL,
  DEFAULT_TOKEN_ADDRESS
};

client.login(DISCORD_TOKEN);
