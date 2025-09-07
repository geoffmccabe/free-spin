// /api/spin.js
// Secure spin + SPL transfer + DB write with robust weighted selection.
// Fix: coerce payout_amounts/weights to numbers; validate lengths; reject zeros; uniform fallback.

import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { createHmac, randomInt } from 'crypto';
import { sendTxWithFreshBlockhash } from '../lib/solanaSend.js';

function bad(res, code, msg, details) {
  res.status(code).json({ error: msg, details });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return bad(res, 405, 'Method not allowed');
  }

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      FUNDING_WALLET_PRIVATE_KEY,
      SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
      COINMARKETCAP_API_KEY,
      SPIN_KEY,
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY || !SPIN_KEY) {
      console.error('FATAL envs missing for spin');
      return bad(res, 500, 'Server not configured');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

    // --------- Parse body & validate token ------------
    const { token: signedToken, spin, server_id } = req.body || {};
    if (!signedToken) return bad(res, 400, 'Token required');
    if (!server_id)   return bad(res, 400, 'Server ID required');

    const [token, sigPart] = String(signedToken).split('.');
    if (!token || !sigPart) return bad(res, 400, 'Invalid token format');
    const expected = createHmac('sha256', SPIN_KEY).update(token).digest('hex');
    if (sigPart !== expected) return bad(res, 403, 'Invalid or forged token');

    // Stored token row
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, server_id, used')
      .eq('token', signedToken)
      .single();

    if (tErr || !t) return bad(res, 400, 'Invalid token');
    if (t.server_id !== server_id) return bad(res, 400, 'Invalid token for this server');
    const { discord_id, wallet_address, contract_address } = t;
    if (t.used) return bad(res, 400, 'This spin token has already been used');

    // Validate server+token mapping
    const [{ data: st, error: stErr }, { data: roleRow }] = await Promise.all([
      supabase.from('server_tokens').select('contract_address').eq('server_id', server_id),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).maybeSingle(),
    ]);
    if (stErr || !st?.some(x => x.contract_address === contract_address)) {
      return bad(res, 400, 'Token not enabled on this server');
    }
    const role = roleRow?.role || null;
    const isSuperadmin = role === 'superadmin';

    // --------- Daily limit (per user per day per token per server) ----------
    let spins_left;
    if (!isSuperadmin) {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error: cntErr } = await supabase
        .from('daily_spins')
        .select('id', { count: 'exact', head: true })
        .eq('discord_id', discord_id)
        .eq('server_id', server_id)
        .eq('contract_address', contract_address)
        .gte('created_at_utc', sinceISO);
      if (cntErr) return bad(res, 500, 'DB error checking spin history', cntErr.message);
      const used = count ?? 0;
      const { data: uRow } = await supabase
        .from('users').select('spin_limit').eq('discord_id', discord_id).maybeSingle();
      const limit = Number(uRow?.spin_limit ?? 1);
      if (used >= limit) return bad(res, 403, 'Daily spin limit reached');
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // --------- Load wheel config ----------
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();
    if (cfgErr || !cfg) return bad(res, 400, 'Wheel not configured for this token');

    // Coerce to **numbers** and validate
    const amounts = Array.isArray(cfg.payout_amounts)
      ? cfg.payout_amounts.map(n => Number(n)).filter(Number.isFinite)
      : [];
    let weights = Array.isArray(cfg.payout_weights)
      ? cfg.payout_weights.map(n => Number(n)).map(n => (Number.isFinite(n) && n > 0 ? n : 0))
      : [];

    // If any mismatch/invalid, force uniform weights
    let usedFallback = false;
    if (weights.length !== amounts.length || amounts.length === 0 || weights.reduce((a, b) => a + b, 0) <= 0) {
      weights = Array(amounts.length).fill(1);
      usedFallback = true;
    }

    // ---------- CONFIG PATH (no spin; just return config/info) ----------
    if (!spin) {
      // Optional admin balances (best-effort)
      let adminInfo;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const poolPubkey = payer.publicKey;
          const tokenMint = new PublicKey(contract_address);
          const ata = await getAssociatedTokenAddress(tokenMint, poolPubkey);

          let tokenAmt = 'N/A', gasAmt = 'N/A', tokenUsdValue = 'N/A', gasUsdValue = 'N/A';
          try {
            const bal = await connection.getTokenAccountBalance(ata);
            tokenAmt = bal.value.uiAmount;
          } catch {}
          try {
            const lamports = await connection.getBalance(poolPubkey, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch {}

          // (optional) USD quotes via CMC
          if (COINMARKETCAP_API_KEY) {
            try {
              const gasRes = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', {
                headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
              });
              const gasJson = await gasRes.json();
              const solPrice = gasJson?.data?.SOL?.quote?.USD?.price;
              if (typeof solPrice === 'number' && typeof gasAmt === 'number') {
                gasUsdValue = (gasAmt * solPrice).toFixed(2);
              }
            } catch {}
          }

          adminInfo = {
            gasSymbol: 'SOL',
            gasAmt,
            gasUsdValue,
            tokenSymbol: cfg.token_name || 'TOKEN',
            tokenAmt,
            tokenUsdValue,
            poolAddr: poolPubkey.toString(),
          };
        } catch {}
      }

      return res.status(200).json({
        tokenConfig: {
          token_name: cfg.token_name || 'TOKEN',
          payout_amounts: amounts,
          image_url: cfg.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
        },
        spins_left,
        adminInfo,
        role,
        contract_address,
        // debug hint only for us (not displayed by UI): tells us if weights fell back
        weights_fallback: usedFallback,
      });
    }

    // ---------- SPIN PATH: robust weighted selection ----------
    // Sum can overflow if weights are HUGE; guard by reducing in Number-safe chunks.
    let totalWeight = 0;
    for (const w of weights) {
      totalWeight += w;
      if (!Number.isFinite(totalWeight)) {
        return bad(res, 400, 'Invalid wheel weights (overflow)');
      }
    }
    if (totalWeight <= 0) {
      // Should never happen due to fallback above
      weights = Array(amounts.length).fill(1);
      totalWeight = amounts.length;
      usedFallback = true;
    }

    const r = randomInt(0, totalWeight); // 0..totalWeight-1 inclusive
    let acc = 0, selectedIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) {
        selectedIndex = i;
        break;
      }
    }
    const rewardAmount = Number(amounts[selectedIndex]); // display units
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      return bad(res, 400, 'Invalid reward configuration');
    }

    // ---------- SPL transfer ----------
    const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const fromTokenAddr = await getAssociatedTokenAddress(tokenMint, payer.publicKey);
    const toTokenAddr   = await getAssociatedTokenAddress(tokenMint, userWallet);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromTokenAddr),
      connection.getAccountInfo(toTokenAddr),
    ]);

    if (!fromInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, fromTokenAddr, payer.publicKey, tokenMint
        )
      );
    }
    if (!toInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, toTokenAddr, userWallet, tokenMint
        )
      );
    }

    // Decimals: 5 (HAROLD). If you later add a decimals column, read it and replace 5 here.
    const DECIMALS = 5;
    const baseUnits = BigInt(Math.round(rewardAmount * (10 ** DECIMALS)));

    ixs.push(
      createTransferInstruction(
        fromTokenAddr,
        toTokenAddr,
        payer.publicKey,
        Number(baseUnits) // spl-token createTransferInstruction expects number for u64-safe ranges in JS impl
      )
    );

    const signature = await sendTxWithFreshBlockhash({
      connection,
      payer,
      instructions: ixs,
      recentAccounts: [],
      maxRetries: 4,
      commitment: 'confirmed',
    });

    // ---------- Record spin ----------
    const nowIso = new Date().toISOString();
    const { error: insErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      contract_address,
      wallet_address,
      reward: String(rewardAmount),        // legacy display column (kept for now)
      amount_base: Number(baseUnits),      // integer base units
      signature,
      created_at_utc: nowIso,
    });
    if (insErr) {
      console.error('Spin insert error:', insErr.message);
      return bad(res, 500, 'Failed to record spin', insErr.message);
    }

    // Burn token
    await supabase.from('spin_tokens').update({ used: true, signature }).eq('token', signedToken);

    return res.status(200).json({
      segmentIndex: selectedIndex,
      prize: `${rewardAmount} ${cfg.token_name || 'TOKEN'}`,
      spins_left,
      // debug echo so we can verify once and then remove:
      debug_weights_used: { amounts, weights, usedFallback },
    });
  } catch (e) {
    console.error('spin fatal:', e);
    return bad(res, 500, 'Spin error', String(e?.message || e));
  }
}
