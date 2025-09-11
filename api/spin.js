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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    // Load spin token
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .maybeSingle();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    if (t.used)     return res.status(400).json({ error: 'This spin token has already been used' });

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

    // Role (for spins_left)
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

    // Wheel config
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
    const decimals = 5;

    if (!amounts.length) return res.status(400).json({ error: 'Wheel has no payout amounts configured' });

    // Page load (no spin)
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

    // 🔒 Mark token as used BEFORE transfer (atomic guard)
    const { data: claim, error: claimErr } = await supabase
      .from('spin_tokens')
      .update({ used: true })
      .eq('token', signedToken)
      .eq('used', false)
      .select()
      .maybeSingle();

    if (claimErr || !claim) {
      return res.status(400).json({ error: 'This spin token has already been used' });
    }

    // Spin: weighted pick
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));

    // Build keys
    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk  = new PublicKey(wallet_address);
    const mintPk  = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPk, userPk);

    // Pre-flight balance check
    try {
      const balInfo = await connection.getTokenAccountBalance(fromATA);
      const baseAmt = Number(balInfo?.value?.amount || 0);
      if (!Number.isFinite(baseAmt) || baseAmt < amountBase) {
        return res.status(503).json({ error: 'Prize pool is low. Please notify an admin.' });
      }
    } catch {
      // ignore, ATA may not exist yet
    }

    // Build instructions
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

    // Send transfer
    let signature;
    try {
      signature = await sendTxWithFreshBlockhash({
        connection,
        payer: funding,
        instructions: ixs,
        maxRetries: 4,
        commitment: 'confirmed',
      });
    } catch (e) {
      const msg = String(e?.message || e);
      console.error('[spin] sendTx error:', msg);
      if (msg.includes('insufficient')) {
        return res.status(503).json({ error: 'Prize pool is empty. Please notify an admin.' });
      }
      if (msg.includes('blockhash')) {
        return res.status(503).json({ error: 'Temporary network issue. Please try again.' });
      }
      return res.status(502).json({ error: 'Token transfer failed. Please try again later.' });
    }

    // Record spin
    const nowISO = new Date().toISOString();
    const { error: insErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: rewardDisplay,
      amount_base: amountBase,
      signature,
      created_at_utc: nowISO,
    });
    if (insErr) {
      console.error('[spin] insert daily_spins error:', insErr.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // Update spin token with signature
    await supabase.from('spin_tokens').update({ signature }).eq('token', signedToken);

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
