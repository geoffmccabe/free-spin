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
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
    console.error('[spin] Missing required env vars');
    return res.status(500).json({ error: 'Server is misconfigured. Admin has been notified.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });

  try {
    const { token: signedToken, server_id, spin } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // === Load spin token (no HMAC check anymore) ===
    const { data: t, error: tErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .maybeSingle();

    if (tErr || !t) return res.status(400).json({ error: 'Invalid token' });
    const { discord_id, wallet_address, contract_address } = t;

    // === Server-token allowlist ===
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

    // === Role ===
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

    // === Wheel config ===
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

    // === Helper to fetch prices ===
    async function getPricesUSD(mintAddress) {
      let solUsd = 0, tokenUsd = 0;
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
        const j = await r.json();
        solUsd = Number(j?.solana?.usd || 0) || 0;
      } catch {}
      try {
        const r2 = await fetch(`https://price.jup.ag/v4/price?ids=${encodeURIComponent(mintAddress)}`);
        const j2 = await r2.json();
        tokenUsd = Number(j2?.data?.[mintAddress]?.price || 0) || 0;
      } catch {}
      return { solUsd, tokenUsd };
    }

    // === Page load (no spin) ===
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

      let adminInfo = {};
      try {
        const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
        const poolAddr = funding.publicKey.toBase58();

        const [lamports, fromATA] = await Promise.all([
          connection.getBalance(funding.publicKey, 'confirmed'),
          getAssociatedTokenAddress(new PublicKey(contract_address), funding.publicKey),
        ]);

        let tokenBase = 0;
        try {
          const balInfo = await connection.getTokenAccountBalance(fromATA, 'confirmed');
          tokenBase = Number(balInfo?.value?.amount || 0) || 0;
        } catch {
          tokenBase = 0;
        }

        const { solUsd, tokenUsd } = await getPricesUSD(contract_address);

        const gasAmt = lamports / 1e9;
        const tokenAmt = tokenBase / (10 ** decimals);

        adminInfo = {
          poolAddr,
          gasAmt,
          gasUsdValue: solUsd ? Math.round(gasAmt * solUsd) : 0,
          tokenAmt,
          tokenUsdValue: tokenUsd ? Math.round(tokenAmt * tokenUsd) : 0,
        };
      } catch (e) {
        console.warn('[spin] adminInfo fetch failed (non-fatal):', e?.message || e);
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

    // === SPIN FLOW ===
    const todayUTC = new Date().toISOString().slice(0, 10);
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
          signature: lockSignature,
          token: signedToken,
          is_test: false,
          created_at_utc: new Date().toISOString(),
          created_at_ms: Date.now(),
          wallet_address: wallet_address || null,
        }])
        .select('id')
        .single();

      if (preErr) {
        return res.status(429).json({ error: 'You have already claimed your spin today.' });
      }
      preclaimRowId = preclaim?.id || null;
    }

    const { data: claimRow, error: claimErr } = await supabase
      .from('spin_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', signedToken)
      .is('used', false)
      .select('discord_id, wallet_address, contract_address')
      .maybeSingle();

    if (claimErr || !claimRow) {
      if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      return res.status(409).json({ error: 'This spin token has already been used' });
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));

    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userPk  = new PublicKey(wallet_address);
    const mintPk  = new PublicKey(contract_address);

    const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mintPk, userPk);

    try {
      const balInfo = await connection.getTokenAccountBalance(fromATA);
      const baseAmt = Number(balInfo?.value?.amount || 0);
      if (!Number.isFinite(baseAmt) || baseAmt < amountBase) {
        if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
        await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('token', signedToken);
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
    } catch {}

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

      if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('token', signedToken);

      if (msg.toLowerCase().includes('insufficient') || msg.includes('0x1')) {
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
      if (msg.toLowerCase().includes('address not found') || msg.toLowerCase().includes('could not find')) {
        return res.status(503).json({ error: 'Temporary RPC issue. Please try again.' });
      }
      return res.status(502).json({ error: 'Token transfer failed (network busy). Please try again.' });
    }

    const nowISO = new Date().toISOString();
    const baseRow = {
      discord_id,
      server_id,
      wallet_address,
      contract_address,
      reward: rewardDisplay,
      amount_base: amountBase,
      signature,
      created_at_utc: nowISO,
      created_at_ms: Date.now(),
      is_test: false,
      token: signedToken,
    };

    if (role !== 'superadmin' && preclaimRowId) {
      const { error: updErr } = await supabase
        .from('daily_spins')
        .update(baseRow)
        .eq('id', preclaimRowId);
      if (updErr) console.error('[spin] update daily_spins (lock->final) error:', updErr.message);
    } else {
      const { error: insErr } = await supabase.from('daily_spins').insert(baseRow);
      if (insErr) console.error('[spin] insert daily_spins (superadmin) error:', insErr.message);
    }

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
