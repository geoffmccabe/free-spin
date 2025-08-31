import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, createTransferInstruction } from '@solana/spl-token';
import { createHmac, randomInt } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token: signedToken, spin, server_id } = req.body;
    if (!signedToken) {
      return res.status(400).json({ error: 'Token required' });
    }
    if (!server_id) {
      return res.status(400).json({ error: 'Server ID required' });
    }

    const TOKEN_SECRET = process.env.SPIN_KEY;
    if (!TOKEN_SECRET) {
      console.error("FATAL: SPIN_KEY environment variable not found or is empty.");
      return res.status(500).json({ error: 'A server configuration error occurred. Please notify an administrator.' });
    }

    const [token, signature] = signedToken.split('.');
    if (!token || !signature) {
      console.error(`Malformed token: ${signedToken}`);
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const expectedSignature = createHmac('sha256', TOKEN_SECRET).update(token).digest('hex');
    if (signature !== expectedSignature) {
      console.error(`Invalid signature for token: ${token}`);
      return res.status(403).json({ error: 'Invalid or forged token' });
    }

    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .single();

    if (tokenError || !tokenData) {
      console.error(`Token query error: ${tokenError?.message || 'No token found'}`);
      return res.status(400).json({ error: 'Invalid token' });
    }
    if (tokenData.used) {
      console.error(`Token already used: ${signedToken}`);
      return res.status(400).json({ error: 'This spin token has already been used' });
    }

    const { discord_id, wallet_address, contract_address } = tokenData;

    const [
      { data: serverTokens, error: serverTokenError },
      { data: userData, error: userError },
      { data: adminData, error: adminError }
    ] = await Promise.all([
      supabase.from('server_tokens').select('contract_address').eq('server_id', server_id),
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single()
    ]);

    if (serverTokenError || !serverTokens?.some(t => t.contract_address === contract_address)) {
      console.error(`Invalid contract_address ${contract_address} for server ${server_id}`);
      return res.status(400).json({ error: 'Invalid token for this server' });
    }
    console.log(`Validated token: ${contract_address} for server ${server_id}`);

    if (userError || !userData) {
      console.error(`User query error: ${userError?.message || 'No user found'}`);
      return res.status(400).json({ error: 'User not found' });
    }

    const isSuperadmin = adminData?.role === 'superadmin';
    console.log(`Admin check: ${discord_id} is ${isSuperadmin ? '' : 'not '}superadmin`);

    let spins_left = userData.spin_limit;
    if (!isSuperadmin) {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      console.log(`Checking spin limit for discord_id: ${discord_id}, contract: ${contract_address}, since: ${twentyFourHoursAgo}`);
      const { data: recentSpins, error: spinCountError } = await supabase
        .from('daily_spins')
        .select('contract_address')
        .eq('discord_id', discord_id)
        .gte('created_at', twentyFourHoursAgo);

      if (spinCountError) {
        console.error(`Spin count error: ${spinCountError.message}`);
        return res.status(500).json({ error: 'DB error checking spin history' });
      }
      spins_left = Math.max(0, userData.spin_limit - recentSpins.length);
      if (recentSpins.length >= userData.spin_limit) {
        console.log(`Spin limit exceeded for discord_id: ${discord_id}`);
        return res.status(403).json({ error: 'Daily spin limit reached' });
      }
    } else {
      console.log(`Bypassing spin limit for superadmin: ${discord_id}`);
      spins_left = 'Unlimited';
    }

    const { data: config, error: configError } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (configError || !config) {
      console.error(`Config error: ${configError?.message || 'No config found'}`);
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }
    
    if (spin) {
      const weights = config.payout_weights || config.payout_amounts.map(() => 1);
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const rand = randomInt(0, totalWeight);
      let sum = 0;
      let selectedIndex = 0;
      for (let i = 0; i < weights.length; i++) {
        sum += weights[i];
        if (rand < sum) { selectedIndex = i; break; }
      }
      const rewardAmount = config.payout_amounts[selectedIndex];
      const prizeText = `${rewardAmount} ${config.token_name}`;

      const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
      const userWallet = new PublicKey(wallet_address);
      const tokenMint = new PublicKey(contract_address);

      const fromTokenAccount = await getOrCreateAssociatedTokenAccount(connection, fundingWallet, tokenMint, fundingWallet.publicKey);
      const toTokenAccount = await getOrCreateAssociatedTokenAccount(connection, fundingWallet, tokenMint, userWallet);

      const transaction = new Transaction().add(
        createTransferInstruction(
          fromTokenAccount.address,
          toTokenAccount.address,
          fundingWallet.publicKey,
          rewardAmount * (10 ** 5)
        )
      );

      const txSignature = await sendAndConfirmTransaction(connection, transaction, [fundingWallet]);
      console.log("Transaction confirmed with signature:", txSignature);

      await supabase.from('daily_spins').insert({ discord_id, reward: rewardAmount, contract_address, signature: txSignature });
      await supabase.from('spin_tokens').update({ used: true, signature: txSignature }).eq('token', signedToken);

      return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText, spins_left });
    } else {
      const tokenConfig = {
        token_name: config.token_name,
        payout_amounts: config.payout_amounts,
        image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Harold_800px.webp'
      };

      let adminInfo = {};
      if (isSuperadmin) {
        const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
        const ata = await getAssociatedTokenAddress(new PublicKey(contract_address), fundingWallet.publicKey);
        let balance = 0;
        try {
          const balanceResponse = await connection.getTokenAccountBalance(ata);
          balance = balanceResponse.value.uiAmount;
        } catch (err) {
          console.error('Balance fetch failed', err);
          balance = 'N/A';
        }

        let usdValue = 0;
        try {
          const cmcRes = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=HAROLD&convert=USD`, {
            headers: {
              'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY
            }
          });
          const cmcData = await cmcRes.json();
          usdValue = balance * cmcData.data.HAROLD.quote.USD.price;
        } catch (err) {
          console.error('CMC price fetch failed', err);
          usdValue = 'N/A';
        }

        adminInfo = {
          tokenAmt: balance,
          usdValue,
          poolAddr: fundingWallet.publicKey.toString()
        };
      }

      return res.status(200).json({ tokenConfig, spins_left, adminInfo });
    }
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
