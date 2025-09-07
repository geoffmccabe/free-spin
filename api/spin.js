// /api/spin.js
import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual, randomInt } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';

// -------- helpers --------
function j(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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
function pickIndexByWeights(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const r = randomInt(0, sum);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return j(res, 405, { error: 'Method not allowed' });

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      SPIN_KEY,
      FUNDING_WALLET_PRIVATE_KEY,
      SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SPIN_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
      return j(res, 500, { error: 'Server configuration missing' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return j(res, 400, { error: 'Token required' });
    if (!server_id) return j(res, 400, { error: 'Server ID required' });

    // verify token
    const parts = String(signedToken).split('.');
    if (parts.length !== 2) return j(res, 400, { error: 'Invalid token format' });
    const [tokenPart, sigHex] = parts;
    if (!hmacOk(tokenPart, sigHex, SPIN_KEY)) return j(res, 403, { error: 'Invalid token signature' });

    // fetch spin token (note: spin_tokens has NO server_id column in your DB)
    const { data: tok, error: tokErr } = await supabase
      .from('spin_tokens')
      .select('used,discord_id,wallet_address,contract_address')
      .eq('token', signedToken)
      .single();
    if (tokErr || !tok) return j(res, 400, { error: 'Invalid token' });
    if (tok.used) return j(res, 400, { error: 'This spin token has already been used' });

    const discord_id = tok.discord_id;
    const wallet_address = tok.wallet_address;
    const contract_address = tok.contract_address;

    // validate token mint belongs to this server
    const { data: st, error: stErr } = await supabase
      .from('server_tokens')
      .select('enabled')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address)
      .maybeSingle();
    if (stErr || !st) return j(res, 400, { error: 'Token/mint not enabled for this server' });
    if (st.enabled === false) return j(res, 403, { error: 'This token is disabled for this server' });

    // load wheel config (add image_url back for the wheel graphic)
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name,payout_amounts,payout_weights,image_url')
      .eq('contract_address', contract_address)
      .single();
    if (cfgErr || !cfg) return j(res, 400, { error: 'Invalid wheel configuration' });

    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts : [];
    const weights =
      Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === amounts.length
        ? cfg.payout_weights
        : amounts.map(() => 1);
    if (amounts.length === 0) return j(res, 400, { error: 'No payout amounts configured' });

    // admin role (to show the admin button)
    const { data: adminRow } = await supabase
      .from('server_admins')
      .select('role')
      .eq('discord_id', discord_id)
      .eq('server_id', server_id)
      .maybeSingle();
    const role = adminRow?.role ?? null; // 'admin' | 'superadmin' | null
    const isSuperadmin = role === 'superadmin';

    // user daily spin limit (for "spins left" display)
    // if absent, default to 1
    let userLimit = 1;
    const { data: userRow } = await supabase
      .from('users')
      .select('spin_limit')
      .eq('discord_id', discord_id)
      .maybeSingle();
    if (typeof userRow?.spin_limit === 'number') userLimit = userRow.spin_limit;

    // count used in the last 24h for display (simple approximation)
    let spins_left = 0;
    if (isSuperadmin) {
      spins_left = 'Unlimited';
    } else {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: usedCount } = await supabase
        .from('daily_spins')
        .select('id', { count: 'exact', head: true })
        .eq('discord_id', discord_id)
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .gte('created_at_utc', sinceISO);
      const used = usedCount ?? 0;
      const limit = Number.isFinite(userLimit) ? userLimit : 1;
      spins_left = Math.max(0, limit - used);
    }

    // ---- CONFIG path (page load) : return everything the frontend needs ----
    if (!spin) {
      return j(res, 200, {
        tokenConfig: {
          token_name: cfg.token_name,
          payout_amounts: amounts,
          image_url: cfg.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
        },
        spins_left,
        role,                // <-- brings back the admin button
        contract_address,
      });
    }

    // ---- SPIN path ----
    const idx = pickIndexByWeights(weights);
    const rewardAmount = Number(amounts[idx]);
    const prizeText = `${rewardAmount} ${cfg.token_name}`;

    // Solana transfer
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPub = new PublicKey(wallet_address);
    const mint = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mint, funding.publicKey);
    const toATA = await getAssociatedTokenAddress(mint, userPub);

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
    ];

    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA, 'processed'),
      connection.getAccountInfo(toATA, 'processed'),
    ]);
    if (!fromInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          funding.publicKey, fromATA, funding.publicKey, mint
        )
      );
    }
    if (!toInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          funding.publicKey, toATA, userPub, mint
        )
      );
    }

    // Your wheels use 5 decimals
    const DECIMALS = 5;
    const amountBase = rewardAmount * 10 ** DECIMALS;

    ixs.push(
      createTransferInstruction(
        fromATA, toATA, funding.publicKey, amountBase
      )
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: funding.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    vtx.sign([funding]);

    const sig = await connection.sendTransaction(vtx, {
      skipPreflight: false,
      maxRetries: 2,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    // record the spin (set BOTH created_at and created_at_utc to keep charts happy)
    const nowIso = new Date().toISOString();
    const payload = {
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: String(rewardAmount),
      amount_base: amountBase,
      signature: sig,
      created_at: nowIso,
      created_at_utc: nowIso,
    };

    const { error: insErr } = await supabase.from('daily_spins').insert(payload);
    if (insErr) {
      const msgText = String(insErr.message || insErr);
      if (msgText.includes('duplicate key value') || msgText.includes('unique')) {
        // DB unique still enforces 1/day. If you truly want superadmin unlimited,
        // we must change that index. For now: report limit.
        return j(res, 403, { error: 'Daily spin limit reached' });
      }
      return j(res, 500, { error: 'Failed to record spin', detail: msgText });
    }

    // mark token used
    await supabase.from('spin_tokens').update({ used: true, signature: sig }).eq('token', signedToken);

    // recompute spins_left for response (display only)
    let spinsLeftAfter = spins_left;
    if (!isSuperadmin && typeof spins_left === 'number') {
      spinsLeftAfter = Math.max(0, spins_left - 1);
    }

    return j(res, 200, {
      segmentIndex: idx,
      prize: prizeText,
      spins_left: isSuperadmin ? 'Unlimited' : spinsLeftAfter,
      signature: sig,
    });
  } catch (err) {
    return j(res, 500, { error: 'Server error', detail: String(err?.message || err) });
  }
}
