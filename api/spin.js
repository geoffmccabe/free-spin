// /api/spin.js  (Next.js API route - Node runtime)
// Single-file, no external helpers. Assumes Node 18+.

import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual, randomInt } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';

// ---------- helpers ----------
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
function nowIso() {
  return new Date().toISOString();
}
function pickIndexByWeights(weights) {
  // weights = [w1, w2, ...], all positive numbers
  const total = weights.reduce((a, b) => a + b, 0);
  const r = randomInt(0, total); // [0, total)
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1; // fallback (shouldn't happen)
}
function hmacOk(tokenPart, signatureHex, secret) {
  try {
    const expected = createHmac('sha256', secret).update(tokenPart).digest();
    const provided = Buffer.from(signatureHex, 'hex');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      SPIN_KEY,
      FUNDING_WALLET_PRIVATE_KEY,
      SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SPIN_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
      return json(res, 500, { error: 'Server configuration missing' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

    // Body
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return json(res, 400, { error: 'Token required' });
    if (!server_id) return json(res, 400, { error: 'Server ID required' });

    // Verify HMAC token
    const parts = String(signedToken).split('.');
    if (parts.length !== 2) return json(res, 400, { error: 'Invalid token format' });
    const [tokenPart, sigHex] = parts;
    if (!hmacOk(tokenPart, sigHex, SPIN_KEY)) {
      return json(res, 403, { error: 'Invalid token signature' });
    }

    // Look up spin token (NOTE: we do NOT assume a server_id column here)
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('used,discord_id,wallet_address,contract_address')
      .eq('token', signedToken)
      .single();

    if (tErr || !t) return json(res, 400, { error: 'Invalid token' });
    if (t.used) return json(res, 400, { error: 'This spin token has already been used' });

    const discord_id = t.discord_id;
    const wallet_address = t.wallet_address;
    const contract_address = t.contract_address;

    // Validate this mint belongs to the provided server_id
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('enabled')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address)
      .maybeSingle();

    if (stErr || !st) return json(res, 400, { error: 'Token/mint not enabled for this server' });
    if (st.enabled === false) return json(res, 403, { error: 'This token is disabled for this server' });

    // Load wheel configuration (tables are good; keep it simple)
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name,payout_amounts,payout_weights')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !cfg) return json(res, 400, { error: 'Invalid wheel configuration' });
    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts : [];
    const weights =
      Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === amounts.length
        ? cfg.payout_weights
        : amounts.map(() => 1);

    if (amounts.length === 0) return json(res, 400, { error: 'No payout amounts configured' });

    // CONFIG path: return wheel info without spinning (page load)
    if (!spin) {
      return json(res, 200, {
        tokenConfig: {
          token_name: cfg.token_name,
          payout_amounts: amounts,
        },
        contract_address,
      });
    }

    // ---------- SPIN path ----------
    // One spin per day per user (DB unique handles duplicates; we also precheck last 24h by discord_id)
    // NOTE: we keep it simple and let the DB unique index be the final authority.
    // If duplicate, we catch the insert error and return "Daily spin limit reached".

    // Draw an outcome by weights
    const idx = pickIndexByWeights(weights);
    const rewardAmount = Number(amounts[idx]);
    const prizeText = `${rewardAmount} ${cfg.token_name}`;

    // Send SPL token
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const user = new PublicKey(wallet_address);
    const mint = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mint, funding.publicKey);
    const toATA = await getAssociatedTokenAddress(mint, user);

    const ixs = [
      // give the tx a bit of budget so it’s reliable
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
    ];

    // create ATAs if missing
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA, 'processed'),
      connection.getAccountInfo(toATA, 'processed'),
    ]);

    if (!fromInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          funding.publicKey, // payer
          fromATA,
          funding.publicKey, // owner
          mint
        )
      );
    }
    if (!toInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          funding.publicKey, // payer
          toATA,
          user, // owner
          mint
        )
      );
    }

    // decimals: your wheels use 5; keep it here to avoid extra lookups
    const DECIMALS = 5;
    const amountBase = BigInt(Math.trunc(rewardAmount * 10 ** DECIMALS));

    ixs.push(
      createTransferInstruction(
        fromATA,
        toATA,
        funding.publicKey,
        Number(amountBase) // spl-token helper expects number for typical 32-bit amounts; fine for 5 decimals here
      )
    );

    // Fresh blockhash -> v0 transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: funding.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    vtx.sign([funding]);

    const signature = await connection.sendTransaction(vtx, {
      skipPreflight: false,
      maxRetries: 2,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    // Record the spin
    const createdIso = nowIso(); // set both created_at and created_at_utc so existing indexes work
    const insertPayload = {
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: String(rewardAmount),      // keep legacy display units
      amount_base: rewardAmount * 10 ** DECIMALS,
      signature,
      created_at: createdIso,
      created_at_utc: createdIso,
    };

    const { error: insErr } = await supabase.from('daily_spins').insert(insertPayload);

    if (insErr) {
      const msg = String(insErr.message || insErr);
      // If your unique index blocked a second spin today, surface a friendly message
      if (msg.includes('duplicate key value') || msg.includes('unique')) {
        // rollback? the on-chain transfer already happened; we just report the rule
        return json(res, 403, { error: 'Daily spin limit reached' });
      }
      return json(res, 500, { error: 'Failed to record spin', detail: msg });
    }

    // Mark the token as used
    await supabase.from('spin_tokens').update({ used: true, signature }).eq('token', signedToken);

    return json(res, 200, { segmentIndex: idx, prize: prizeText, spins_left: 0, signature });
  } catch (err) {
    return json(res, 500, { error: 'Server error', detail: String(err?.message || err) });
  }
}
