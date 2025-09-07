// /api/spin.js
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { createHmac, randomInt } from 'crypto';
import { sendTxWithFreshBlockhash } from '../lib/solanaSend.js';

// ----- helpers -----
const readParams = (req) => (req.method === 'GET' ? req.query : req.body);
const nowISO = () => new Date().toISOString();

function toNumArray(val) {
  // Accept JSON, PG array "{1,2}", or "1,2,3"
  if (Array.isArray(val)) return val.map((x) => Number(x));
  if (val == null) return [];
  const s = String(val).trim();
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map((x) => Number(x));
  } catch (_) {}
  if (s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1).split(',').map(Number);
  if (s.includes(',')) return s.split(',').map(Number);
  return [Number(s)];
}

function pickWeighted(amounts, weights) {
  if (!amounts.length) throw new Error('empty amounts');
  if (weights.length !== amounts.length) weights = amounts.map(() => 1);
  const w = weights.map((x) => Number(x));
  if (w.some((x) => !Number.isFinite(x) || x < 0)) throw new Error('invalid weights');
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('invalid weights sum');
  let r = randomInt(0, total); // 0..total-1
  for (let i = 0; i < w.length; i++) {
    if (r < w[i]) return i;
    r -= w[i];
  }
  return w.length - 1; // fallback (should never hit)
}

// ----- handler -----
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      FUNDING_WALLET_PRIVATE_KEY,
      SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
      SPIN_KEY,
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY || !SPIN_KEY) {
      return res.status(500).json({ error: 'Server configuration missing required envs' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

    const p = readParams(req);
    const rawToken = String(p.token || '').trim();
    const server_id = p.server_id ? String(p.server_id).trim() : null;
    const doSpin = (req.method === 'POST') || String(p.spin || '') === '1';

    if (!rawToken) return res.status(400).json({ error: 'Token required' });

    // Expect the exact value stored in DB: "<uuid>.<hmac>"
    // No guessing with partial tokens — that caused the earlier “invalid token”.
    const { data: tokenRow, error: tErr } = await supabase
      .from('spin_tokens')
      .select('token, used, discord_id, wallet_address, contract_address')
      .eq('token', rawToken)
      .single();

    if (tErr || !tokenRow) return res.status(400).json({ error: 'Invalid token' });
    if (tokenRow.used) return res.status(400).json({ error: 'This spin token has already been used' });

    // Extra safety: verify HMAC (won’t block valid stored tokens unless tampered)
    const [uuid, sig] = rawToken.split('.');
    if (!uuid || !sig) return res.status(400).json({ error: 'Invalid token format' });
    const expect = createHmac('sha256', SPIN_KEY).update(uuid).digest('hex');
    if (sig !== expect) return res.status(403).json({ error: 'Invalid token signature' });

    const { discord_id, wallet_address, contract_address } = tokenRow;

    // Load wheel config (read only existing columns; do NOT require non-existent ones)
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !cfg) return res.status(400).json({ error: 'Invalid wheel configuration' });

    // Parse config strictly to numbers (this fixes the “always 3” bug)
    const amounts = toNumArray(cfg.payout_amounts).filter((n) => Number.isFinite(n) && n > 0);
    let weights = toNumArray(cfg.payout_weights).filter((n) => Number.isFinite(n) && n >= 0);

    if (!amounts.length) return res.status(400).json({ error: 'Payout table misconfigured' });
    if (weights.length !== amounts.length) weights = amounts.map(() => 1);

    // CONFIG PATH (page load)
    if (!doSpin) {
      return res.status(200).json({
        tokenConfig: {
          token_name: cfg.token_name,
          payout_amounts: amounts,
          image_url: cfg.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
        },
        contract_address,
      });
    }

    // ----- SPIN -----
    const idx = pickWeighted(amounts, weights);
    const rewardAmount = amounts[idx];

    // Harold uses 5 decimals; keep it simple & explicit here.
    const DECIMALS = 5;
    const amountBase = Math.round(rewardAmount * 10 ** DECIMALS);

    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const mint = new PublicKey(contract_address);
    const user = new PublicKey(wallet_address);

    const fromATA = await getAssociatedTokenAddress(mint, funding.publicKey);
    const toATA = await getAssociatedTokenAddress(mint, user);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA),
      connection.getAccountInfo(toATA),
    ]);
    if (!fromInfo) ixs.push(createAssociatedTokenAccountInstruction(funding.publicKey, fromATA, funding.publicKey, mint));
    if (!toInfo)   ixs.push(createAssociatedTokenAccountInstruction(funding.publicKey, toATA,   user,          mint));
    ixs.push(createTransferInstruction(fromATA, toATA, funding.publicKey, amountBase));

    const signature = await sendTxWithFreshBlockhash({
      connection, payer: funding, instructions: ixs, recentAccounts: [], maxRetries: 4, commitment: 'confirmed',
    });

    // Write exactly the columns you already have (no new columns)
    const { error: insErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: String(rewardAmount),   // legacy display
      amount_base: amountBase,        // base units (decimals=5)
      signature,
      created_at: nowISO(),           // uses your existing created_at
    });

    if (insErr) {
      // 23505 from your unique index = “already spun today”
      if (insErr.code === '23505') return res.status(403).json({ error: 'Daily spin limit reached' });
      console.error('Insert failed:', insErr);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // burn the token
    await supabase.from('spin_tokens').update({ used: true, signature }).eq('token', rawToken);

    return res.status(200).json({ segmentIndex: idx, prize: `${rewardAmount} ${cfg.token_name}`, signature });
  } catch (e) {
    console.error('spin.js fatal:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
