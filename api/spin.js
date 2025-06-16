const { createClient } = require('@supabase/supabase-js');
const { Connection, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const [tokenValue, signature] = token.split(':');
    const expectedSignature = crypto.createHmac('sha256', TOKEN_SECRET).update(tokenValue).digest('hex');
    if (signature !== expectedSignature) {
      return res.status(403).json({ error: 'Invalid token signature' });
    }

    const { data: tokenData, error: tokenError } = await retryQuery(() =>
      supabase.from('spin_tokens').select('discord_id, wallet_address, contract_address').eq('token', token).eq('used', false).single()
    );
    if (tokenError || !tokenData) {
      return res.status(400).json({ error: 'Invalid or used token' });
    }

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await retryQuery(() =>
      supabase.from('daily_spins')
        .select('*', { count: 'exact', head: true })
        .eq('discord_id', tokenData.discord_id)
        .eq('contract_address', tokenData.contract_address)
        .gte('created_at', twentyFourHoursAgo)
    );
    if (count > 0) {
      return res.status(400).json({ error: 'Daily spin limit exceeded' });
    }

    const { data: wheelConfig, error: configError } = await retryQuery(() =>
      supabase.from('wheel_configurations').select('payout_weights, payout_amounts, token_name').eq('contract_address', tokenData.contract_address).single()
    );
    if (configError || !wheelConfig) {
      return res.status(500).json({ error: 'Failed to fetch wheel configuration' });
    }

    const weights = wheelConfig.payout_weights;
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const rand = crypto.randomBytes(4).readUInt32LE(0) % totalWeight;
    let sum = 0;
    let segment = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (rand < sum) { segment = i; break; }
    }
    const amount = wheelConfig.payout_amounts[segment];

    const wallet = Keypair.fromSecretKey(Buffer.from(WALLET_PRIVATE_KEY, 'base64'));
    const recipient = new PublicKey(tokenData.wallet_address);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: recipient,
        lamports: amount * 1e9 // Assuming token decimals
      })
    );
    const signature = await solanaConnection.sendTransaction(transaction, [wallet]);
    await solanaConnection.confirmTransaction(signature);

    const { error: spinInsertError } = await retryQuery(() =>
      supabase.from('daily_spins').insert({
        discord_id: tokenData.discord_id,
        reward: amount,
        contract_address: tokenData.contract_address,
        signature,
        created_at: new Date().toISOString()
      })
    );
    if (spinInsertError) {
      console.error(`Spin insert error: ${spinInsertError.message}`);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    const { error: tokenUpdateError } = await retryQuery(() =>
      supabase.from('spin_tokens').update({ used: true }).eq('token', token)
    );
    if (tokenUpdateError) {
      console.error(`Token update error: ${tokenUpdateError.message}`);
    }

    return res.status(200).json({ segment, amount, signature });
  } catch (error) {
    console.error(`Spin processing error: ${error.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
