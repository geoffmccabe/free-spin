import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { randomInt } from 'crypto';
import { sendTxWithFreshBlockhash } from '../lib/solanaSend.js';

// ---- tiny helpers -----------------------------------------------------------
const readParams = (req) => (req.method === 'GET' ? req.query : req.body);
const num = (v) => Number(v ?? 0);
const nowISO = () => new Date().toISOString();

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      FUNDING_WALLET_PRIVATE_KEY,
      SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
      return res.status(500).json({ error: 'Server config missing envs' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

    const params = readParams(req);
    const signedToken = String(params.token || '').trim();
    const spinRequested = String(params.spin || '').trim() === '1';

    if (!signedToken) return res.status(400).json({ error: 'Token required' });

    // --- token lookup: accept full "uuid.hmac" OR just "uuid"
    const uuidPart = signedToken.split('.')[0];
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('spin_tokens')
      .select('token, used, discord_id, wallet_address, contract_address')
      .or(`token.eq.${signedToken},token.eq.${uuidPart}`)
      .single();

    if (tokenErr || !tokenRow) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    if (tokenRow.used) {
      return res.status(400).json({ error: 'This spin token has already been used' });
    }

    const { discord_id, wallet_address, contract_address } = tokenRow;

    // --- load wheel configuration
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, decimals, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !cfg) {
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }

    // ---- CONFIG PATH (no spin) ---------------------------------------------
    if (!spinRequested) {
      return res.status(200).json({
        tokenConfig: {
          token_name: cfg.token_name,
          payout_amounts: cfg.payout_amounts,
          image_url: cfg.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
        },
        contract_address,
      });
    }

    // ---- SPIN PATH ----------------------------------------------------------
    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts.map(num) : [];
    const weights = (Array.isArray(cfg.payout_weights) &&
                     cfg.payout_weights.length === amounts.length)
                      ? cfg.payout_weights.map(num)
                      : amounts.map(() => 1);

    const totalWeight = weights.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
    if (!amounts.length || totalWeight <= 0) {
      return res.status(400).json({ error: 'Payout table misconfigured' });
    }

    // weighted choice
    let r = randomInt(0, totalWeight);
    let idx = 0;
    for (; idx < weights.length; idx++) {
      if (r < weights[idx]) break;
      r -= weights[idx];
    }
    const rewardAmount = amounts[idx]; // display units (e.g., 3, 30, 100)
    const decimals = num(cfg.decimals || 5);
    const amountBase = BigInt(Math.round(rewardAmount * 10 ** decimals));

    // build token transfer
    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPub = new PublicKey(wallet_address);
    const mintPub = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPub, fundingWallet.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPub, userPub);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA),
      connection.getAccountInfo(toATA),
    ]);

    if (!fromInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        fundingWallet.publicKey, fromATA, fundingWallet.publicKey, mintPub
      ));
    }
    if (!toInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        fundingWallet.publicKey, toATA, userPub, mintPub
      ));
    }

    ixs.push(createTransferInstruction(
      fromATA, toATA, fundingWallet.publicKey, Number(amountBase) // spl-token lib uses number
    ));

    const signature = await sendTxWithFreshBlockhash({
      connection,
      payer: fundingWallet,
      instructions: ixs,
      recentAccounts: [],
      maxRetries: 4,
      commitment: 'confirmed',
    });

    // record spin (use columns that exist)
    const insertPayload = {
      discord_id,
      server_id: params.server_id || null,   // nullable is okay
      wallet_address,
      contract_address,
      reward: String(rewardAmount),          // legacy display
      amount_base: Number(amountBase),       // base units
      signature,
      created_at: nowISO(),                  // table has created_at; trigger will fill created_at_ms if present
    };

    const { error: insErr } = await supabase.from('daily_spins').insert(insertPayload);
    if (insErr) {
      // if uniqueness prevents second spin in a day, surface a clear error
      const code = insErr?.code || '';
      if (code === '23505') {
        return res.status(403).json({ error: 'Daily spin limit reached' });
      }
      console.error('Insert failed:', insErr);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // burn the token
    await supabase.from('spin_tokens').update({ used: true, signature }).or(`token.eq.${signedToken},token.eq.${uuidPart}`);

    return res.status(200).json({
      segmentIndex: idx,
      prize: `${rewardAmount} ${cfg.token_name}`,
      signature,
    });

  } catch (err) {
    console.error('spin.js fatal:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
