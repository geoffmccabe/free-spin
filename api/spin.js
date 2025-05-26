import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const HAROLD_TOKEN_MINT = new PublicKey("3vgopg7xm3EWkXfxmWPUpcf7g939hecfqg18sLuXDzVt");

const connection = new Connection('https://api.mainnet-beta.solana.com');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
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
      { text: '1 HAROLD', amount: 1, weight: 30000 },
      { text: '10 HAROLD', amount: 10, weight: 2000 },
      { text: '100 HAROLD', amount: 100, weight: 400 },
      { text: '300 HAROLD', amount: 300, weight: 200 },
      { text: '3000 HAROLD', amount: 3000, weight: 50 },
      { text: '10000 HAROLD', amount: 10000, weight: 10 }
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
    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(tokenRow.discord_id); // user's public key in `discord_id`

    // Send HAROLD token
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
        reward.amount,
        [],
        TOKEN_PROGRAM_ID
      )
    );

    await connection.sendTransaction(tx, [fundingWallet]);

    await supabase
      .from('spin_tokens')
      .update({ used: true, reward: reward.amount })
      .eq('token', token);

    await supabase
      .from('daily_spins')
      .insert({ discord_id: tokenRow.discord_id, reward: reward.amount });

    res.status(200).json({ prize: reward.text, segmentIndex: selectedIndex });
  } catch (err) {
    console.error('Spin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
