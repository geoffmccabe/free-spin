import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
let getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createTransferInstruction, TOKEN_PROGRAM_ID;

const splToken = await import('@solana/spl-token');
getAssociatedTokenAddress = splToken.getAssociatedTokenAddress;
getOrCreateAssociatedTokenAccount = splToken.getOrCreateAssociatedTokenAccount;
createTransferInstruction = splToken.createTransferInstruction;
TOKEN_PROGRAM_ID = splToken.TOKEN_PROGRAM_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const HAROLD_TOKEN_MINT = new PublicKey("3vgopg7xm3EWkXfxmWPUpcf7g939hecfqg18sLuXDzVt");

const connection = new Connection('https://api.mainnet-beta.solana.com');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://solspin.lightningworks.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided' });

    const { data: tokenRow, error } = await supabase
      .from('spin_tokens')
      .select('*')
      .eq('token', token)
      .single();

    if (error || !tokenRow || tokenRow.used) {
      console.error("Token error:", error || "Used or invalid token");
      return res.status(400).json({ error: 'Invalid or used token' });
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

    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(tokenRow.discord_id);

    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      fundingWallet,
      HAROLD_TOKEN_MINT,
      fundingWallet.publicKey
    );

    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      fundingWallet,
      HAROLD_TOKEN_MINT,
      userWallet
    );

    const tx = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fundingWallet.publicKey,
        reward.amount * 100000, // Convert to base units
        [],
        TOKEN_PROGRAM_ID
      )
    );

    await connection.sendTransaction(tx, [fundingWallet]);

    await supabase
      .from('spin_tokens')
      .update({ used: true, reward: reward.amount })
      .eq('token', token);

// Log the daily spin
await supabase
  .from('daily_spins')
  .insert({ discord_id: tokenRow.discord_id, reward: reward.amount });

// Update wallet_totals (leaderboard)
await supabase.rpc('increment_wallet_total', {
  wallet_address: tokenRow.discord_id,
  reward_amount: reward.amount
});


    console.log("Returning: segmentIndex:", selectedIndex, "Prize:", reward.text);
    res.status(200).json({ prize: reward.text, segmentIndex: selectedIndex });
  } catch (err) {
    console.error('Spin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
