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
    const { token: signedToken, spin } = req.body;
    if (!signedToken) {
      return res.status(400).json({ error: 'Token required' });
    }

    const TOKEN_SECRET = process.env.TOKEN_SECRET;
    if (!TOKEN_SECRET) {
      console.error("FATAL: TOKEN_SECRET environment variable not found or is empty.");
      return res.status(500).json({ error: 'Server configuration error' });
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
      return res.status(400).json({ error: 'Token already used' });
    }

    const { discord_id, wallet_address, contract_address } = tokenData;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    console.log(`Checking spin limit for discord_id: ${discord_id}, contract: ${contract_address}, since: ${twentyFourHoursAgo}`);
    const { count, error: spinCountError } = await supabase
      .from('daily_spins')
      .select('*', { count: 'exact', head: true })
      .eq('discord_id', discord_id)
      .eq('contract_address', contract_address)
      .gte('created_at', twentyFourHoursAgo);

    if (spinCountError) {
      console.error(`Spin count error: ${spinCountError.message}`);
      throw new Error('DB error checking spin history');
    }
    if (count > 0) {
      console.log(`Spin limit exceeded for discord_id: ${discord_id}`);
      return res.status(403).json({ error: 'Daily spin limit reached' });
    }

    const { data: config, error: configError } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .eq('active', true)
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

      return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText });
    } else {
      const tokenConfig = {
        token_name: config.token_name,
        payout_amounts: config.payout_amounts,
        image_url: config.image_url,
      };
      return res.status(200).json({ tokenConfig });
    }
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
