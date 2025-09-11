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

  // ---- ENV ----
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FUNDING_WALLET_PRIVATE_KEY,
    SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    SPIN_KEY,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY || !SPIN_KEY) {
    console.error('[spin] Missing required env vars');
    return res.status(500).json({ error: 'Server is misconfigured. Admin has been notified.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

  try {
    // ---- INPUT ----
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // ---- HMAC VERIFY (uuid.hmac) ----
    const [rawToken, providedSig] = String(signedToken).split('.');
    if (!rawToken || !providedSig) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const expectedSig = createHmac('sha256', SPIN_KEY).update(rawToken).digest('hex');
    if (providedSig !== expectedSig) {
      return res.status(403).json({ error: 'Invalid token signature' });
    }

    // ---- FETCH SPIN TOKEN ----
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .maybeSingle();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    if (t.used)     return res.status(400).json({ error: 'This spin token has already been used' });

    const { discord_id, wallet_address, contract_address } = t;

    // ---- SERVER ↔ TOKEN CHECK ----
    const { data: stRows, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);

    if (stErr || !Array.isArray(stRows) || !stRows.length) {
      console.error('[spin] server_tokens error', stErr?.message);
      return res.status(400).json({ error: 'Server is not configured for any tokens' });
    }
    const allowed = stRows.some(r => r.contract_address === contract_address && (r.enabled !== false));
    if (!allowed) {
      return res.status(400).json({ error: 'This token is not enabled for this server' });
    }

    // ---- ROLE (for superadmin bypass) ----
    let role = null;
    {
      const { data: adminRow } = await supabase
        .from('server_admins')
        .select('role')
        .eq('server_id', server_id)
        .eq('discord_id', discord_id)
        .maybeSingle();
      role = adminRow?.role || null;
    }

    // ---- LOAD WHEEL CONFIG ----
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .maybeSingle();

    if (cfgErr || !cfg) {
      console.error('[spin] config error', cfgErr?.message);
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }

    const tokenName = cfg.token_name || 'Token';
    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts.map(Number) : [];
    const weights = Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === amounts.length
      ? cfg.payout_weights.map(Number)
      : amounts.map(() => 1);

    if (!amounts.length) {
      return res.status(400).json({ error: 'Wheel has no payout amounts configured' });
    }

    // ---- PAGE LOAD PATH (spin not requested) ----
    if (!spin) {
      // Spins-left: 1 per 24h per discord_id (superadmin shows Unlimited)
      let spins_left = 1;
      try {
        if (role === 'superadmin') {
          spins_left = 'Unlimited';
        } else {
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
        }
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
        role,
        spins_left,
        contract_address,
      });
    }

    // =====================================================================
    // SINGLE FIX: PER-WALLET DAILY LIMIT (blocks farming to same wallet)
    // =====================================================================
    if (role !== 'superadmin') {
      try {
        const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: walletToday } = await supabase
          .from('daily_spins')
          .select('id', { count: 'exact', head: true })
          .eq('server_id', server_id)
          .eq('contract_address', contract_address)
          .eq('wallet_address', wallet_address)
          .gte('created_at_utc', sinceISO);

        if ((walletToday ?? 0) > 0) {
          // Optional: burn the token so it can’t be reused
          await supabase.from('spin_tokens')
            .update({ used: true, signature: 'wallet_daily_limit' })
            .eq('token', signedToken);

          return res.status(429).json({ error: 'Daily limit reached for this wallet.' });
        }
      } catch (e) {
        console.error('[spin] per-wallet check failed:', e?.message || e);
        // Fail safe: do NOT allow if we can’t check. Prevent drain on outage.
        await supabase.from('spin_tokens')
          .update({ used: true, signature: 'wallet_check_failed' })
          .eq('token', signedToken);
        return res.status(503).json({ error: 'Please try again later.' });
      }
    }
    // =====================================================================

    // ---- SPIN PATH ----
    // Weighted pick (server-side)
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);          // e.g. 3, 30, 100, etc.
    const decimals = 5;                                  // HAROLD / FATCOIN use 5
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));

    // Build & send transfer
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk  = new PublicKey(wallet_address);
    const mintPk  = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPk, userPk);

    const ixs = [];

    // Ensure ATAs exist
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

    ixs.push(createTransferInstruction(
      fromATA, toATA, funding.publicKey, amountBase
    ));

    let signature;
    try {
      signature = await sendTxWithFreshBlockhash({
        connection,
        payer: funding,
        instructions: ixs,
        recentAccounts: [],
        maxRetries: 4,
        commitment: 'confirmed',
      });
    } catch (e) {
      const msg = String(e?.message || e);
      console.error('[spin] sendTx error:', msg);

      if (msg.includes('insufficient') || msg.includes('Insufficient') || msg.includes('0x1')) {
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
      if (msg.includes('address not found') || msg.includes('could not find')) {
        return res.status(503).json({ error: 'Temporary RPC issue. Please try again.' });
      }
      return res.status(502).json({ error: 'Token transfer failed (network busy). Please try again.' });
    }

    // Record spin (must include created_at_utc for your trigger)
    const nowISO = new Date().toISOString();
    const { error: insErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: String(rewardDisplay),   // keep legacy display units
      amount_base: amountBase,         // canonical
      signature,
      created_at_utc: nowISO,
    });

    if (insErr) {
      console.error('[spin] insert daily_spins error:', insErr.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // Burn the token
    await supabase
      .from('spin_tokens')
      .update({ used: true, signature })
      .eq('token', signedToken);

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
