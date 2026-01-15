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

client.on('interactionCreate', async (interaction) => { try { 
  if (interaction.isAutocomplete()) {
    console.log(`Handling autocomplete for command: ${interaction.commandName}, server: ${interaction.guildId}`);
    if (['spin', 'freespin', 'dailyspin', 'leaders', 'leaderboard', 'spinleaders'].includes(interaction.commandName)) {
      const server_id = interaction.guildId;
      try {
        const focusedValue = interaction.options.getFocused();
        console.log(`Focused value: ${focusedValue}`);
        const { data: serverTokens, error: tokenError } = await retryQuery(() =>
          supabase.from('server_tokens').select('contract_address, enabled').eq('server_id', server_id)
        );
        if (tokenError) {
          console.error(`Token query error: ${tokenError.message}`);
          await interaction.respond([]);
          return;
        }
        const contract_addresses = serverTokens?.map(t => t.contract_address) || [DEFAULT_TOKEN_ADDRESS];
        console.log(`Contract addresses: ${contract_addresses.join(', ')}`);
        const { data: coinData, error: coinError } = await retryQuery(() =>
          supabase.from('wheel_configurations').select('contract_address, token_name').in('contract_address', contract_addresses)
        );
        if (coinError) {
          console.error(`Coin query error: ${coinError.message}`);
          await interaction.respond([]);
          return;
        }

        const uniqueTokens = Array.from(new Map(coinData.map(c => [c.token_name, c])).values());
        let choices = uniqueTokens.map(c => ({ name: c.token_name, value: c.token_name }));
        if (!choices.length) {
          choices = [{ name: 'HAROLD', value: 'HAROLD' }];
        }
        const filteredChoices = choices.filter(c => c.name.toLowerCase().startsWith(focusedValue.toLowerCase())).slice(0, 25);
        console.log(`Sending choices: ${JSON.stringify(filteredChoices)}`);
        await interaction.respond(filteredChoices);
      } catch (error) {
        console.error(`Autocomplete error: ${error.message}`);
        await interaction.respond([]);
      }
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const _chName = interaction.channel?.name || '(unknown)';
  console.log(`Received command: ${interaction.commandName}, channel: ${_chName}`);

  if (["spin", "freespin", "dailyspin"].includes(interaction.commandName)) {
    if ((interaction.channel?.name || '').toLowerCase() !== SPIN_CHANNEL_NAME.toLowerCase()) {
      console.log(`Channel mismatch: expected ${SPIN_CHANNEL_NAME}, got ${_chName}`);
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
  } else {
    await interaction.reply({ content: `Unknown command. Try /spinhelp`, flags: 64 });
  }
} catch (err) { 
  console.error(`interaction handler error: ${err?.message||err}`);
  try { 
    if (interaction && interaction.reply && !interaction.replied) { 
      await interaction.reply({content:'❌ An error occurred handling your command.', flags:64}); 
    } 
  } catch {} 
} });

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName("spin").setDescription("Spin the wheel to win tokens")
      .addStringOption(option =>
        option.setName("token_name")
          .setDescription("Choose a token to spin")
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder().setName("freespin").setDescription("Alias for /spin")
      .addStringOption(option =>
        option.setName("token_name")
          .setDescription("Choose a token to spin")
          .setRequired(false)
          .setAutocomplete(true)
      ),
    new SlashCommandBuilder().setName("dailyspin").setDescription("Alias for /spin")
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
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commands });
    console.log("Slash commands registered successfully");
  } catch (error) {
    console.error(`Error registering commands: ${error.message}`);
  }
}

registerSlashCommands();

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
