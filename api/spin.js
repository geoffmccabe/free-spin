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

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FUNDING_WALLET_PRIVATE_KEY,
    SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    SPIN_KEY,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY || !SPIN_KEY) {
    console.error('Missing required env vars');
    return res.status(500).json({ error: 'Server is misconfigured. Admin has been notified.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

  try {
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // ---- HMAC VERIFY ----
    const [rawToken, providedSig] = String(signedToken).split('.');
    if (!rawToken || !providedSig) return res.status(400).json({ error: 'Invalid token format' });
    const expectedSig = createHmac('sha256', SPIN_KEY).update(rawToken).digest('hex');
    if (providedSig !== expectedSig) return res.status(403).json({ error: 'Invalid token signature' });

    // ---- FETCH SPIN TOKEN ----
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .single();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    if (t.used)     return res.status(400).json({ error: 'This spin token has already been used' });

    const { discord_id, wallet_address, contract_address } = t;

    // ---- SERVER ↔ TOKEN CHECK ----
    const { data: stRows, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);

    if (stErr || !Array.isArray(stRows) || !stRows.length) {
      return res.status(400).json({ error: 'Server is not configured for any tokens' });
    }
    const allowed = stRows.some(r => r.contract_address === contract_address && (r.enabled !== false));
    if (!allowed) return res.status(400).json({ error: 'This token is not enabled for this server' });

    // ---- WHEEL CONFIG ----
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !cfg) return res.status(400).json({ error: 'Invalid wheel configuration' });

    const tokenName = cfg.token_name || 'Token';
    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts.map(Number) : [];
    const weights = Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === amounts.length
      ? cfg.payout_weights.map(Number)
      : amounts.map(() => 1);

    if (!amounts.length) return res.status(400).json({ error: 'Wheel has no payout amounts configured' });

    // ---- PAGE LOAD (no spin) ----
    if (!spin) {
      let spins_left = 1;
      try {
        const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count } = await supabase
          .from('daily_spins')
          .select('id', { count: 'exact', head: true })
          .eq('discord_id', discord_id)
          .eq('server_id', server_id)
          .eq('contract_address', contract_address)
          .gte('created_at_utc', sinceISO);
        const used = count ?? 0;
        spins_left = Math.max(0, 1 - used);
      } catch {
        spins_left = 1;
      }

      return res.status(200).json({
        tokenConfig: {
          token_name: tokenName,
          payout_amounts: amounts,
          payout_weights: weights,
          image_url: cfg.image_url || '/img/Wheel_Generic_800px.webp',
        },
        spins_left,
        contract_address,
      });
    }

    // ---- SPIN (weighted pick) ----
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);
    const decimals = 5; // Harold / Fatcoin
    const amountBase = rewardDisplay * (10 ** decimals);

    // ---- BUILD TRANSFER ----
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk  = new PublicKey(wallet_address);
    const mintPk  = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPk, userPk);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA),
      connection.getAccountInfo(toATA),
    ]);
    if (!fromInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        funding.publicKey, fromATA, funding.publicKey, mintPk
      ));
    }
    if (!toInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        funding.publicKey, toATA, userPk, mintPk
      ));
    }
    ixs.push(createTransferInstruction(fromATA, toATA, funding.publicKey, amountBase));

    // ---- SEND W/ RETRIES ----
    async function tryOnce(retryIndex = 0) {
      return await sendTxWithFreshBlockhash({
        connection,
        payer: funding,
        instructions: ixs,
        recentAccounts: [],
        maxRetries: 4 + retryIndex,
        commitment: 'confirmed',
      });
    }

    let signature = '';
    let ok = false;
    const attempts = 3;
    const baseDelay = 800;

    for (let i = 0; i < attempts; i++) {
      try {
        console.log(`[spin] transfer attempt ${i + 1}/${attempts}`);
        signature = await tryOnce(i);
        ok = true;
        break;
      } catch (e) {
        const msg = (e?.message || String(e)).toLowerCase();
        const transient =
          msg.includes('busy') || msg.includes('blockhash') || msg.includes('rate') ||
          msg.includes('429')  || msg.includes('timeout')   || msg.includes('unavailable') ||
          msg.includes('gateway') || msg.includes('connection') || msg.includes('slot');
        if (i < attempts - 1 && transient) {
          await new Promise(r => setTimeout(r, baseDelay * (2 ** i)));
          continue;
        }
        console.error('Transfer failed (final):', e?.message || e);
        signature = '';       // <-- pending marker (empty string, not NULL)
        ok = false;
        break;
      }
    }

    // ---- RECORD SPIN (no NULLs) ----
    const nowISO = new Date().toISOString();
    const { error: insErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: String(rewardDisplay),
      amount_base: amountBase,
      signature,            // '' if pending, tx sig string if succeeded
      created_at_utc: nowISO,
    });

    if (insErr) {
      console.error('Insert error:', insErr.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // ---- BURN TOKEN ----
    await supabase
      .from('spin_tokens')
      .update({ used: true, signature }) // '' if pending
      .eq('token', signedToken);

    // ---- RESPOND ----
    if (!ok) {
      return res.status(200).json({
        segmentIndex: idx,
        prize: `${rewardDisplay} ${tokenName}`,
        pending: true,
        message: 'Network congested — payout will be retried automatically.',
      });
    }

    return res.status(200).json({
      segmentIndex: idx,
      prize: `${rewardDisplay} ${tokenName}`,
      signature,
    });

  } catch (err) {
    console.error('Unhandled spin error:', err?.message || err);
    return res.status(500).json({ error: 'A server error occurred' });
  }
}
