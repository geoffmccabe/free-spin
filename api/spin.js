import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
let getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID;

const splToken = await import('@solana/spl-token');
getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
getOrCreateAssociatedTokenAccount = splToken.getOrCreateAssociatedTokenAccount;
createTransferInstruction = splToken.createTransferInstruction;
TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HAROLD_TOKEN_MINT = new PublicKey("3vgopg7xm3EWkXfxmWPUpcf7g939hecfqg18sLuXDzVt");

const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://solspin.lightningworks.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method !== 'POST') {
      console.error("Invalid method:", req.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { token } = req.body;
    if (!token) {
      console.error("No token provided");
      return res.status(400).json({ error: 'No token provided' });
    }

    const { data: tokenRow, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !tokenRow || tokenRow.used) {
      console.error("Token error:", tokenError?.message || "Used or invalid token");
      return res.status(400).json({ error: 'Invalid or used token' });
    }

    const { data: limitRow, error: limitError } = await supabase
      .from('spin_limits')
      .select('daily_spin_limit')
      .eq('wallet_address', tokenRow.wallet_address)
      .single();

    const dailySpinLimit = limitRow?.daily_spin_limit || 1;

    const { data: recentSpins, error: spinError } = await supabase
      .from('daily_spins')
      .select('id')
      .eq('discord_id', tokenRow.discord_id)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(dailySpinLimit + 1);

    if (spinError) {
      console.error("Spin check error:", spinError.message);
      return res.status(500).json({ error: 'Failed to check spin limit' });
    }

    if (recentSpins.length >= dailySpinLimit) {
      console.error("Daily spin limit reached for:", tokenRow.discord_id);
      return res.status(400).json({ error: 'Daily spin limit reached' });
    }

    const rewardOptions = [
      { text: '3 HAROLD', amount: 3, weight: 10000 },
      { text: '30 HAROLD', amount: 30, weight: 3000 },
      { text: '100 HAROLD', amount: 100, weight: 300 },
      { text: '300 HAROLD', amount: 300, weight: 100 },
      { text: '3000 HAROLD', amount: 3000, weight: 10 },
      { text: '30000 HAROLD', amount: 30000, weight: 1 }
    ];

    const totalWeight = rewardOptions.reduce((sum, r) => sum + r.weight, 0);
    let rand = Math.random() * totalWeight;
    let selectedIndex = 0;
    for (let i = 0; i < rewardOptions.length; i++) {
      rand -= rewardOptions[i].weight;
      if (rand <= 0) {
        selectedIndex = i;
        break;
      }
    }

    const reward = rewardOptions[selectedIndex];
    console.log("Selected Index:", selectedIndex, "Reward:", reward.text, "Amount:", reward.amount);

    if (!FUNDING_WALLET_PRIVATE_KEY) {
      console.error("Missing FUNDING_WALLET_PRIVATE_KEY");
      return res.status(500).json({ error: 'Server configuration error' });
    }

    let fundingWallet;
    try {
      fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
      console.log("Funding wallet loaded:", fundingWallet.publicKey.toString());
    } catch (err) {
      console.error("Invalid FUNDING_WALLET_PRIVATE_KEY:", err.message);
      return res.status(500).json({ error: 'Invalid wallet configuration' });
    }

    let userWallet;
    try {
      userWallet = new PublicKey(tokenRow.wallet_address);
      console.log("User wallet loaded:", userWallet.toString());
    } catch (err) {
      console.error("Invalid user wallet address:", tokenRow.wallet_address, err.message);
      return res.status(400).json({ error: 'Invalid user wallet address' });
    }

    let fromTokenAccount, toTokenAccount;
    try {
      fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fundingWallet,
        HAROLD_TOKEN_MINT,
        fundingWallet.publicKey
      );
      toTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fundingWallet,
        HAROLD_TOKEN_MINT,
        userWallet
      );
      console.log("Token accounts loaded:", fromTokenAccount.address.toString(), toTokenAccount.address.toString());
    } catch (err) {
      console.error("Token account error:", err.message);
      return res.status(500).json({ error: 'Failed to create token account: ' + err.message });
    }

    const tx = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fundingWallet.publicKey,
        reward.amount * 100000,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    let txSignature;
    try {
      txSignature = await connection.sendTransaction(tx, [fundingWallet], { skipPreflight: true });
      console.log("Transaction sent:", txSignature);
      await connection.confirmTransaction(txSignature, 'confirmed');
      console.log("Transaction confirmed:", txSignature);
    } catch (err) {
      console.error("Transaction error:", err.message);
      return res.status(500).json({ error: 'Transaction failed: ' + err.message });
    }

    await supabase
      .from('spin_tokens')
      .update({ used: true, reward: reward.amount })
      .eq('token
