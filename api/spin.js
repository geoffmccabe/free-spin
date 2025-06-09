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

const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  console.log('Spin API request received:', req.method, req.body);
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

    console.log("Fetching spin token:", token);
    const { data: tokenRow, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !tokenRow) {
      console.error("Token query error:", tokenError?.message || "No token found");
      return res.status(400).json({ error: 'Invalid or used token' });
    }
    if (tokenRow.used) {
      console.error("Token already used:", token);
      return res.status(400).json({ error: 'Token already used' });
    }

    const { discord_id, wallet_address, contract_address } = tokenRow;
    console.log(`Spin token data: discord_id=${discord_id}, wallet=${wallet_address}, contract=${contract_address}`);

    // Fetch token configuration
    const { data: tokenConfig, error: configError } = await supabase
      .from('wheel_configurations')
      .select('payout_amounts, payout_weights, token_name')
      .eq('contract_address', contract_address)
      .eq('active', true)
      .single();

    if (configError || !tokenConfig) {
      console.error("Token config error:", configError?.message || "No active token found");
      return res.status(400).json({ error: 'Invalid token configuration' });
    }

    // Return tokenConfig for initial wheel load
    if (!req.body.spin) {
      console.log('Returning token config for wheel initialization');
      return res.status(200).json({ tokenConfig });
    }

    const { payout_amounts, payout_weights, token_name } = tokenConfig;
    console.log(`Token config: name=${token_name}, payouts=${payout_amounts}`);

    // Verify user has a registered wallet
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('discord_id', discord_id)
      .single();

    if (userError || !userData) {
      console.error("User not found for discord_id:", discord_id);
      return res.status(400).json({ error: 'No wallet registered' });
    }

    // Select reward
    const totalWeight = payout_weights.reduce((sum, w) => sum + w, 0);
    let rand = Math.random() * totalWeight;
    let selectedIndex = 0;
    for (let i = 0; i < payout_weights.length; i++) {
      rand -= payout_weights[i];
      if (rand <= 0) {
        selectedIndex = i;
        break;
      }
    }

    const rewardAmount = payout_amounts[selectedIndex];
    const prizeText = `${rewardAmount} ${token_name}`;
    console.log("Selected reward:", { index: selectedIndex, prize: prizeText, amount: rewardAmount });

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
      userWallet = new PublicKey(wallet_address);
      console.log("User wallet loaded:", userWallet.toString());
    } catch (err) {
      console.error("Invalid user wallet address:", wallet_address, err.message);
      return res.status(400).json({ error: 'Invalid user wallet address' });
    }

    let tokenMint;
    try {
      tokenMint = new PublicKey(contract_address);
      console.log("Token mint loaded:", tokenMint.toString());
    } catch (err) {
      console.error("Invalid token mint address:", contract_address, err.message);
      return res.status(400).json({ error: 'Invalid token mint address' });
    }

    let fromTokenAccount, toTokenAccount;
    try {
      fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fundingWallet,
        tokenMint,
        fundingWallet.publicKey
      );
      toTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fundingWallet,
        tokenMint,
        userWallet
      );
      console.log("Token accounts:", fromTokenAccount.address.toString(), toTokenAccount.address.toString());
    } catch (err) {
      console.error("Token account error:", err.message);
      return res.status(500).json({ error: 'Failed to create token account: ' + err.message });
    }

    const tx = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fundingWallet.publicKey,
        rewardAmount * 100000, // Adjust for token decimals
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

    console.log("Updating spin token:", token);
    await supabase
      .from('spin_tokens')
      .update({ used: true, reward: rewardAmount })
      .eq('token', token);

    console.log("Inserting daily spin:", discord_id);
    await supabase
      .from('daily_spins')
      .insert({ discord_id, reward: rewardAmount, contract_address });

    console.log("Updating wallet totals:", wallet_address);
    await supabase.rpc('increment_wallet_total', {
      wallet_address,
      reward_amount: rewardAmount
    });

    console.log("Returning response:", { segmentIndex: selectedIndex, prize: prizeText });
    return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText });
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
}
