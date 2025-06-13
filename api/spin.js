import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, createTransferInstruction } from '@solana/spl-token';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).json({});
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, spin } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (tokenError || !tokenData) {
      return res.status(400).json({ error: 'Invalid or used token' });
    }

    const { discord_id, wallet_address, contract_address } = tokenData;

    const { data: config, error: configError } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, image_url, token_id')
      .eq('contract_address', contract_address)
      .eq('active', true)
      .single();

    if (configError || !config) {
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }

    const tokenConfig = {
      token_name: config.token_name,
      payout_amounts: config.payout_amounts,
      image_url: config.image_url,
      token_id: config.token_id,
    };

    if (spin) {
      const weights = config.payout_amounts.map((_, i) => 1 / (i + 1));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const normalizedWeights = weights.map(w => w / totalWeight);
      let random = Math.random();
      let selectedIndex = 0;
      for (let i = 0; i < normalizedWeights.length; i++) {
        random -= normalizedWeights[i];
        if (random <= 0) {
          selectedIndex = i;
          break;
        }
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

      const signature = await sendAndConfirmTransaction(connection, transaction, [fundingWallet], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      console.log("Transaction confirmed with signature:", signature);

      const { error: tokenUpdateError } = await supabase
        .from('spin_tokens')
        .update({ used: true, signature })
        .eq('token', token);

      if (tokenUpdateError) {
        console.error("Token update error:", tokenUpdateError);
        return res.status(500).json({ error: 'Failed to update spin token' });
      }

      const { error: spinInsertError } = await supabase
        .from('daily_spins')
        .insert({ discord_id, reward: rewardAmount, contract_address, signature });

      if (spinInsertError) {
        console.error("Spin insert error:", spinInsertError);
        return res.status(500).json({ error: 'Failed to record spin' });
      }

      const { data: walletTotal, error: walletTotalError } = await supabase
        .from('wallet_totals')
        .select('total_won')
        .eq('wallet_address', wallet_address)
        .eq('contract_address', contract_address)
        .single();

      if (walletTotalError && walletTotalError.code !== 'PGRST116') {
        console.error("Wallet total error:", walletTotalError);
        return res.status(500).json({ error: 'Failed to update wallet total' });
      }

      const newTotal = walletTotal ? walletTotal.total_won + rewardAmount : rewardAmount;
      const { error: walletUpdateError } = await supabase
        .from('wallet_totals')
        .upsert({ wallet_address, contract_address, total_won: newTotal }, { onConflict: 'wallet_address,contract_address' });

      if (walletUpdateError) {
        console.error("Wallet update error:", walletUpdateError);
        return res.status(500).json({ error: 'Failed to update wallet total' });
      }

      return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText });
    } else {
      return res.status(200).json({ tokenConfig });
    }
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    const errorMessage = err.message || 'An unknown error occurred.';
    return res.status(500).json({ error: `Transaction failed: ${errorMessage}` });
  }
}
