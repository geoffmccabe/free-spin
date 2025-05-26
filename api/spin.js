import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from '@solana/web3.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const FUNDING_WALLET_PUBLIC_KEY = process.env.FUNDING_WALLET_PUBLIC_KEY;

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
      { text: '0.001 SOL', lamports: 1000000, weight: 40 },
      { text: '0.01 SOL',  lamports: 10000000, weight: 25 },
      { text: '0.02 SOL',  lamports: 20000000, weight: 15 },
      { text: '0.05 SOL',  lamports: 50000000, weight: 10 },
      { text: '0.1 SOL',   lamports: 100000000, weight: 5 },
      { text: 'Try Again', lamports: 0, weight: 5 }
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
    const userWallet = new PublicKey(tokenRow.discord_id); // Replace this with real wallet lookup if needed

    if (reward.lamports > 0) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fundingWallet.publicKey,
          toPubkey: userWallet,
          lamports: reward.lamports
        })
      );
      await connection.sendTransaction(tx, [fundingWallet]);
    }

    await supabase
      .from('spin_tokens')
      .update({ used: true, reward: reward.lamports })
      .eq('token', token);

    await supabase
      .from('daily_spins')
      .insert({ discord_id: tokenRow.discord_id, reward: reward.lamports });

    res.status(200).json({ prize: reward.text, segmentIndex: selectedIndex });
  } catch (err) {
    console.error('Spin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
