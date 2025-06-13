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
  } catch
