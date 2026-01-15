// /api/spin.js
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { randomInt } from 'crypto';
import { sendTxWithFreshBlockhash } from '../lib/solanaSend.js';

function utcDateStringYYYYMMDD(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pickWeightedIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = randomInt(0, Math.max(1, total));
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return 0;
}

function tierForIndex(idx, n) {
  // Simple, stable mapping: lowest prizes are common, highest are legendary
  const tiers = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  if (n <= 1) return 'common';
  const scaled = Math.floor((idx / (n - 1)) * (tiers.length - 1));
  return tiers[Math.max(0, Math.min(tiers.length - 1, scaled))];
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FUNDING_WALLET_PRIVATE_KEY,
    SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
    console.error('[spin] Missing required env vars');
    return res.status(500).json({ error: 'Server is misconfigured.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

  try {
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id) return res.status(400).json({ error: 'Server ID required' });

    // Load spin token
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('token, server_id, discord_id, wallet_address, contract_address, status')
      .eq('token', signedToken)
      .maybeSingle();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    if (t.server_id !== server_id) return res.status(400).json({ error: 'Token does not match server' });

    const discord_id = t.discord_id;
    const wallet_address = t.wallet_address;
    const contract_address = t.contract_address;

    // Allowlist: token enabled for this server
    const { data: stRows, error: stErr } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);

    if (stErr || !Array.isArray(stRows) || !stRows.length) {
      console.error('[spin] server_tokens error', stErr?.message);
      return res.status(400).json({ error: 'Server is not configured for any tokens' });
    }
    const allowed = stRows.some(
      (r) => r.contract_address === contract_address && (r.enabled !== false)
    );
    if (!allowed) return res.status(400).json({ error: 'This token is not enabled for this server' });

    // Role check
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

    // Wheel config (must be scoped by server_id + contract_address)
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url, decimals')
      .eq('server_id', server_id)
      .eq('contract_address', contract_address)
      .maybeSingle();

    if (cfgErr || !cfg) {
      console.error('[spin] config error', cfgErr?.message);
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }

    const tokenName = cfg.token_name || 'Token';
    const amounts = Array.isArray(cfg.payout_amounts) ? cfg.payout_amounts.map(Number) : [];
    if (!amounts.length) return res.status(400).json({ error: 'Wheel has no payout amounts configured' });

    const weights = Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === amounts.length
      ? cfg.payout_weights.map(Number)
      : amounts.map(() => 1);

    const decimals = Number.isFinite(Number(cfg.decimals)) ? Number(cfg.decimals) : 0;

    // Page load (no spin)
    if (!spin) {
      let spins_left = 1;

      if (role === 'superadmin') {
        spins_left = 'Unlimited';
      } else {
        const today = utcDateStringYYYYMMDD(new Date());
        const { count } = await supabase
          .from('daily_spins')
          .select('id', { count: 'exact', head: true })
          .eq('server_id', server_id)
          .eq('discord_id', discord_id)
          .eq('contract_address', contract_address)
          .eq('spin_day', today);
        const used = count ?? 0;
        spins_left = Math.max(0, 1 - used);
      }

      // adminInfo is optional, keep it best-effort
      let adminInfo = {};
      try {
        const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
        const poolAddr = funding.publicKey.toBase58();

        const mintPk = new PublicKey(contract_address);
        const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);

        const lamports = await connection.getBalance(funding.publicKey, 'confirmed');
        let tokenBase = 0;
        try {
          const balInfo = await connection.getTokenAccountBalance(fromATA, 'confirmed');
          tokenBase = Number(balInfo?.value?.amount || 0) || 0;
        } catch {}

        const gasAmt = lamports / 1e9;
        const tokenAmt = tokenBase / (10 ** decimals);

        adminInfo = { poolAddr, gasAmt, tokenAmt };
      } catch {
        adminInfo = {};
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
        adminInfo,
      });
    }

    // SPIN FLOW
    if (!wallet_address) return res.status(400).json({ error: 'Wallet not set for this token' });

    // Superadmins: allow spins without daily lock and without recording to daily_spins (avoids unique constraint)
    const enforceDaily = role !== 'superadmin';

    // Reserve the token atomically
    const nowISO = new Date().toISOString();
    const { data: reserved, error: rErr } = await supabase
      .from('spin_tokens')
      .update({ status: 'reserved', reserved_at: nowISO })
      .eq('token', signedToken)
      .eq('server_id', server_id)
      .eq('status', 'issued')
      .select('token, discord_id, wallet_address, contract_address')
      .maybeSingle();

    if (rErr || !reserved) {
      return res.status(409).json({ error: 'This spin token is not available' });
    }

    // Enforce daily limit via DB unique constraint
    let dailyRowId = null;
    if (enforceDaily) {
      const { data: ins, error: insErr } = await supabase
        .from('daily_spins')
        .insert([{
          server_id,
          discord_id,
          wallet_address,
          contract_address,
          spin_token: signedToken,
          payout_amount_raw: 0,
          tier: null,
          tx_signature: null,
        }])
        .select('id')
        .single();

      if (insErr || !ins) {
        // User already spun today, void this token to stop repeated attempts
        await supabase
          .from('spin_tokens')
          .update({ status: 'void', reserved_at: null })
          .eq('token', signedToken)
          .eq('server_id', server_id);
        return res.status(429).json({ error: 'Daily limit reached' });
      }
      dailyRowId = ins.id;
    }

    // Choose prize
    const idx = pickWeightedIndex(weights);
    const rewardDisplay = Number(amounts[idx]);
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));
    const tier = tierForIndex(idx, amounts.length);

    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk = new PublicKey(wallet_address);
    const mintPk = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA = await getAssociatedTokenAddress(mintPk, userPk);

    // Check pool balance
    try {
      const balInfo = await connection.getTokenAccountBalance(fromATA, 'confirmed');
      const baseAmt = Number(balInfo?.value?.amount || 0);
      if (!Number.isFinite(baseAmt) || baseAmt < amountBase) {
        if (dailyRowId) await supabase.from('daily_spins').delete().eq('id', dailyRowId);
        await supabase.from('spin_tokens').update({ status: 'issued', reserved_at: null }).eq('token', signedToken);
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
    } catch {
      // If RPC fails here, we still attempt transfer and handle failure.
    }

    // Build instructions with ATA create if needed
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

      if (dailyRowId) await supabase.from('daily_spins').delete().eq('id', dailyRowId);
      await supabase.from('spin_tokens').update({ status: 'issued', reserved_at: null }).eq('token', signedToken);

      return res.status(502).json({ error: 'Token transfer failed. Please try again.' });
    }

    // Record result
    if (dailyRowId) {
      await supabase
        .from('daily_spins')
        .update({
          payout_amount_raw: amountBase,
          tier,
          tx_signature: signature,
        })
        .eq('id', dailyRowId);
    }

    await supabase
      .from('spin_tokens')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('token', signedToken)
      .eq('server_id', server_id);

    return res.status(200).json({
      segmentIndex: idx,
      prize: `${rewardDisplay} ${tokenName}`,
      signature,
      tier,
      spins_left: role === 'superadmin' ? 'Unlimited' : undefined,
    });

  } catch (err) {
    console.error('[spin] Unhandled error:', err?.message || err);
    return res.status(500).json({ error: 'A server error occurred' });
  }
}
