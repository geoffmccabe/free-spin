// /api/spin.js  (ATA-gated + robust spin_tokens lookup + optional debug)
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
    const { token: signedToken, server_id, spin, ata_check, debug } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // Parse & verify HMAC
    const [rawToken, providedSig] = String(signedToken).split('.');
    if (!rawToken || !providedSig) return res.status(400).json({ error: 'Invalid token format' });
    const expectedSig = createHmac('sha256', SPIN_KEY).update(rawToken).digest('hex');
    if (providedSig !== expectedSig) return res.status(403).json({ error: 'Invalid token signature' });

    // ---- Robust spin_tokens lookup: try several variants ----
    const selCols = 'id, discord_id, wallet_address, contract_address, used, server_id';
    let t = null, tErr = null, lookupPath = null;

    // 1) Stored as full signed token in `token` column
    let q = await supabase.from('spin_tokens').select(selCols).eq('token', signedToken).maybeSingle();
    tErr = q.error; t = q.data; lookupPath = 'token=signedToken';

    if (!t) {
      // 2) Stored as raw UUID in `token` column
      q = await supabase.from('spin_tokens').select(selCols).eq('token', rawToken).maybeSingle();
      tErr = q.error; t = q.data; if (t) lookupPath = 'token=rawToken';
    }
    if (!t) {
      // 3) Stored as raw UUID in `id` column
      q = await supabase.from('spin_tokens').select(selCols).eq('id', rawToken).maybeSingle();
      tErr = q.error; t = q.data; if (t) lookupPath = 'id=rawToken';
    }
    if (!t && !tErr) {
      // 4) Last resort: try id=signedToken (in case bot stored full string in id)
      q = await supabase.from('spin_tokens').select(selCols).eq('id', signedToken).maybeSingle();
      tErr = q.error; t = q.data; if (t) lookupPath = 'id=signedToken';
    }

    if (tErr) {
      console.error('[spin] spin_tokens lookup error:', tErr.message || tErr);
    }
    if (!t) {
      // Provide clear debug context when requested
      const dbg = {
        reason: 'spin_tokens_not_found',
        lookupTried: lookupPath,
        supabaseUrlTail: SUPABASE_URL?.slice(-24),
        server_id,
        rawToken,
        signedTokenSample: signedToken.slice(0, 12) + '…' + signedToken.slice(-12),
      };
      return res.status(400).json({ error: 'Invalid token', ...(debug ? { debug: dbg } : {}) });
    }

    if (String(t.server_id) !== String(server_id)) {
      return res.status(400).json({ error: 'Server mismatch' });
    }

    const { discord_id, wallet_address, contract_address, used } = t;
    const isSuperadmin = await isUserSuperadmin(supabase, server_id, discord_id);
    const role = isSuperadmin ? 'superadmin' : null;

    if (used) return res.status(409).json({ error: 'This spin token has already been used' });

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
    const decimals = 5; // your original default
    if (!amounts.length) return res.status(400).json({ error: 'Wheel has no payout amounts configured' });

    // ===== ATA CHECK MODE (no side effects) =====
    if (ata_check) {
      if (!wallet_address) {
        return res.status(400).json({ error: 'No wallet on file for this token' });
      }
      const mintPk = new PublicKey(contract_address);
      const userPk = new PublicKey(wallet_address);
      const userATA = await getAssociatedTokenAddress(mintPk, userPk);
      let ataExists = false;
      try {
        const info = await connection.getAccountInfo(userATA, 'confirmed');
        ataExists = !!info;
      } catch {
        ataExists = false;
      }
      return res.status(200).json({
        ok: true,
        ata_exists: ataExists,
        token_name: tokenName,
        mint_address: contract_address,
        is_superadmin: role === 'superadmin',
      });
    }

    // ===== Page load (no spin): return config + spins_left + adminInfo =====
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
          const usedCt = count ?? 0;
          spins_left = Math.max(0, 1 - usedCt);
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
          tokenBase = 0; // ATA may not exist yet
        }

        // Optional best-effort pricing (unchanged)
        let solUsd = 0, tokenUsd = 0;
        try {
          const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
          const j = await r.json();
          solUsd = Number(j?.solana?.usd || 0) || 0;
        } catch {}
        try {
          const r2 = await fetch(`https://price.jup.ag/v4/price?ids=${encodeURIComponent(contract_address)}`);
          const j2 = await r2.json();
          tokenUsd = Number(j2?.data?.[contract_address]?.price || 0) || 0;
        } catch {}

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

      // Include mint for helper screen
      return res.status(200).json({
        tokenConfig: {
          token_name: tokenName,
          payout_amounts: amounts,
          payout_weights: weights,
          image_url: cfg.image_url || '/img/Wheel_Generic_800px.webp',
          mint_address: contract_address,
        },
        role,
        spins_left,
        contract_address,
        adminInfo,
        ...(debug || role === 'superadmin' ? { debug: { lookupPath, supabaseUrlTail: SUPABASE_URL.slice(-24) } } : {})
      });
    }

    // ====== SPIN FLOW (hardened against racing tabs) ======
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

    // Atomic token consume (keep using the same key the row was found by)
    // We don't know which column exists, so attempt both safely.
    const clearUsed = async () => {
      await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('token', signedToken);
      await supabase.from('spin_tokens').update({ used: false, used_at: null }).eq('id', rawToken);
    };

    let claimRow = null;
    // Try update by `token`; if no row was updated, try by `id`
    let qUp = await supabase
      .from('spin_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', signedToken)
      .is('used', false)
      .select('discord_id, wallet_address, contract_address')
      .maybeSingle();

    if (!qUp.data) {
      qUp = await supabase
        .from('spin_tokens')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('id', rawToken)
        .is('used', false)
        .select('discord_id, wallet_address, contract_address')
        .maybeSingle();
    }
    claimRow = qUp.data;

    if (!claimRow || qUp.error) {
      if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      return res.status(409).json({ error: 'This spin token has already been used' });
    }

    // Weighted pick
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r < acc) { idx = i; break; }
    }
    const rewardDisplay = Number(amounts[idx]);
    const amountBase = Math.trunc(rewardDisplay * (10 ** decimals));

    // Build addresses; quick pool check
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
        await clearUsed();
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
    } catch {
      // continue; ATA may be created by tx below (funding side)
    }

    // DO NOT create the user's ATA anymore (ATA gate)
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
      if (preclaimRowId) await supabase.from('daily_spins').delete().eq('id', preclaimRowId);
      await clearUsed();
      return res.status(409).json({
        error: 'NO_ATA',
        message: `No ${cfg.token_name || 'Token'} token account found on your wallet. Please create it in your wallet and try again.`,
        token_name: cfg.token_name || 'Token',
        mint_address: contract_address,
      });
    }

    ixs.push(createTransferInstruction(
      fromATA, toATA, funding.publicKey, amountBase
    ));

    // Send
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
      await clearUsed();

      if (msg.toLowerCase().includes('insufficient') || msg.includes('0x1')) {
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }
      if (msg.toLowerCase().includes('address not found') || msg.toLowerCase().includes('could not find')) {
        return res.status(503).json({ error: 'Temporary RPC issue. Please try again.' });
      }
      return res.status(502).json({ error: 'Token transfer failed (network busy). Please try again.' });
    }

    // Record spin
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
    await supabase.from('spin_tokens').update({ signature }).eq('id', rawToken);

    return res.status(200).json({
      segmentIndex: idx,
      prize: `${rewardDisplay} ${cfg.token_name || 'Token'}`,
      spins_left: role === 'superadmin' ? 'Unlimited' : undefined,
      signature,
      ...(debug || role === 'superadmin' ? { debug: { usedLookup: lookupPath } } : {})
    });

  } catch (err) {
    console.error('Unhandled spin error:', err?.message || err);
    return res.status(500).json({ error: 'A server error occurred' });
  }
}

// helper: superadmin check (matches your server_admins table)
async function isUserSuperadmin(supabase, server_id, discord_id) {
  try {
    const { data } = await supabase
      .from('server_admins')
      .select('role')
      .eq('server_id', server_id)
      .eq('discord_id', discord_id)
      .maybeSingle();
    return (data?.role || '').toLowerCase() === 'superadmin';
  } catch {
    return false;
  }
}
