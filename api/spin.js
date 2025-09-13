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
    console.error('[spin] Missing required env vars');
    return res.status(500).json({ error: 'Server is misconfigured. Admin has been notified.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

  try {
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // Verify HMAC
    const [rawToken, providedSig] = String(signedToken).split('.');
    if (!rawToken || !providedSig) return res.status(400).json({ error: 'Invalid token format' });
    const expectedSig = createHmac('sha256', SPIN_KEY).update(rawToken).digest('hex');
    if (providedSig !== expectedSig) return res.status(403).json({ error: 'Invalid token signature' });

    // Load spin token (single read — no mutation here)
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .maybeSingle();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    const { discord_id, wallet_address, contract_address } = t;

    // Server-token allowlist
    const { data: stRows, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);

    if (stErr || !Array.isArray(stRows) || !stRows.length) {
      console.error('[spin] server_tokens error', stErr?.message);
      return res.status(400).json({ error: 'Server is not configured for any tokens' });
    }
    const allowed = stRows.some(r => r.contract_address === contract_address && (r.enabled !== false));
    if (!allowed) return res.status(400).json({ error: 'This token is not enabled for this server' });

    // Role
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

    // Wheel config (no decimals column in your schema; set default)
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
    const decimals = 5; // default

    if (!amounts.length) return res.status(400).json({ error: 'Wheel has no payout amounts configured' });

    // Page load (no spin): return config + spins_left
    if (!spin) {
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

    // === ACTUAL SPIN FLOW (exploit-safe) ===

    // A) For non-superadmins, insert a "pre-claim lock" row into daily_spins
    //    We use the unique signature index to allow only 1 claim per (user,server,token,UTC day).
    //    For superadmins, skip the per-day lock (they can test repeatedly) but still consume the token atomically.
    const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lockSignature = `lock:${server_id}|${discord_id}|${contract_address}|${todayUTC}`;

    let preclaimRowId = null;
    if (role !== 'superadmin') {
      const { data: preclaim, error: preErr } = await supabase
        .from('daily_spins')
        .insert([{
          discord_id,
          server_id,
          contract_address,
          reward: 0,
          amount_base: 0,
          signature: lockSignature,  // unique "lock"
          token: signedToken,
          is_test: false,
          created_at_utc: new Date().toISOString(),
          created_at_ms: Date.now(),
          wallet_address: wallet_address || null,
        }])
        .select('id')
        .single();

      if (preErr) {
        // Unique violation on signature means they already spun today
        // (or another tab claimed the pre-lock first)
        return res.status(429).json({ error: 'You have already claimed your spin today.' });
      }
      preclaimRowId = preclaim?.id || null;
    }

    // B) Atomically consume THIS token so it cannot be reused in another tab
    const { data: claimRow, error: claimErr } = await supabase
      .from('spin_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', signedToken)
      .is('used', false)
      .select('discord_id, wallet_address, contract_address')
      .maybeSingle();

    if (claimErr || !claimRow) {
      // Token was already used (race) — clean up the preclaim lock (if any)
      if (preclaimRowId) {
        await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      }
      return res.status(409).json({ error: 'This spin token has already been used' });
    }

    // C) Weighted pick
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));

    // D) Build addresses and do a quick prize pool check
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk  = new PublicKey(wallet_address);
    const mintPk  = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPk, userPk);

    try {
      const balInfo = await connection.getTokenAccountBalance(fromATA);
      const baseAmt = Number(balInfo?.value?.amount || 0);
      if (!Number.isFinite(baseAmt) || baseAmt < amountBase) {
        // Revert token + preclaim so user can try later
        if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
        await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('token', signedToken);
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
    } catch {
      // continue; if ATA missing, we’ll create it in the tx
    }

    // E) Build ixs (create ATAs if missing), then send
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

    ixs.push(createTransferInstruction(
      fromATA, toATA, funding.publicKey, amountBase
    ));

    let signature;
    try {
      signature = await sendTxWithFreshBlockhash({
        connection,
        payer: funding,
        instructions: ixs,
        recentAccounts: [fromATA, toATA, mintPk, userPk.toBase58()],
        maxRetries: 4,
        commitment: 'confirmed',
      });
    } catch (e) {
      const msg = String(e?.message || e);
      console.error('[spin] sendTx error:', msg);

      // Clean up so user can try again later; do not burn the token or keep the lock
      if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('token', signedToken);

      if (msg.includes('insufficient') || msg.includes('Insufficient') || msg.includes('0x1')) {
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
      if (msg.includes('address not found') || msg.includes('could not find')) {
        return res.status(503).json({ error: 'Temporary RPC issue. Please try again.' });
      }
      return res.status(502).json({ error: 'Token transfer failed (network busy). Please try again.' });
    }

    // F) Update the preclaim row (or insert a final row for superadmin) with real data
    const nowISO = new Date().toISOString();
    const baseRow = {
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: rewardDisplay,
      amount_base: amountBase,
      signature,                 // swap out the lock with the real tx id
      created_at_utc: nowISO,
      created_at_ms: Date.now(),
      is_test: false,
      token: signedToken,
    };

    if (role !== 'superadmin' && preclaimRowId) {
      // Update the lock row in place
      const { error: updErr } = await supabase
        .from('daily_spins')
        .update(baseRow)
        .eq('id', preclaimRowId);
      if (updErr) {
        console.error('[spin] update daily_spins (lock->final) error:', updErr.message);
        // We won't revert the transfer; log and continue
      }
    } else {
      // Superadmin path: just insert a normal row (unlimited testing)
      const { error: insErr } = await supabase.from('daily_spins').insert(baseRow);
      if (insErr) {
        console.error('[spin] insert daily_spins (superadmin) error:', insErr.message);
      }
    }

    // Also mark the spin_token row with the tx signature (optional)
    await supabase
      .from('spin_tokens')
      .update({ signature })
      .eq('token', signedToken);

    // Response
    return res.status(200).json({
      segmentIndex: idx,
      prize: `${rewardDisplay} ${tokenName}`,
      spins_left: role === 'superadmin' ? 'Unlimited' : undefined,
      signature,
    });

  } catch (err) {
    console.error('Unhandled spin error:', err?.message || err);
    return res.status(500).json({ error: 'A server error occurred' });
  }
}
