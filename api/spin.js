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
import { verifySignedToken } from '../lib/auth.js';

function utcDateStringYYYYMMDD(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pickWeightedIndex(weights) {
  // Sanitise: a NaN/negative weight from bad config used to make randomInt() throw,
  // which aborted the request *after* the daily slot had been consumed.
  const safe = weights.map((w) => {
    const n = Math.floor(Number(w));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = safe.reduce((a, b) => a + b, 0);
  if (total <= 0) return randomInt(0, Math.max(1, safe.length)); // all-zero config → uniform
  const r = randomInt(0, total);
  let acc = 0;
  for (let i = 0; i < safe.length; i++) {
    acc += safe[i];
    if (r < acc) return i;
  }
  return safe.length - 1;
}

function tierForAmount(amount, amounts) {
  // Rank by prize VALUE, not by position in the array. The old index-based version
  // silently mislabelled every wheel whose payout_amounts weren't sorted ascending.
  const tiers = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
  const distinct = [...new Set(amounts.map(Number))].sort((a, b) => a - b);
  if (distinct.length <= 1) return 'common';
  const rank = distinct.indexOf(Number(amount));
  if (rank < 0) return 'common';
  const scaled = Math.floor((rank / (distinct.length - 1)) * (tiers.length - 1));
  return tiers[Math.max(0, Math.min(tiers.length - 1, scaled))];
}

// Decimal-string → integer base units. `display * 10**decimals` in floating point
// truncated some prizes down by one base unit (e.g. 8.2 * 1e6 = 8199999.999...).
function toBaseUnits(display, decimals) {
  const s = String(display).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return NaN;
  const neg = s.startsWith('-');
  const [intPart = '0', fracPart = ''] = s.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const n = Number(`${intPart}${frac}`.replace(/^0+(?=\d)/, ''));
  return neg ? -n : n;
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
    const { token: signedToken, server_id, spin, ata_check } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id) return res.status(400).json({ error: 'Server ID required' });

    // Reject forged tokens early (only enforced when SPIN_KEY is configured).
    if (verifySignedToken(signedToken) === false) {
      return res.status(403).json({ error: 'Invalid token' });
    }

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

    // ATA existence probe (read-only). atadetection.js has always called this; the
    // server never implemented it, so the helper screen could never succeed.
    if (ata_check && !spin) {
      let ata_exists = false;
      try {
        if (wallet_address) {
          const userAta = await getAssociatedTokenAddress(
            new PublicKey(contract_address),
            new PublicKey(wallet_address)
          );
          ata_exists = !!(await connection.getAccountInfo(userAta));
        }
      } catch {
        ata_exists = false;
      }
      return res.status(200).json({
        ok: true,
        ata_exists,
        token_name: tokenName,
        mint_address: contract_address,
        is_superadmin: role === 'superadmin',
      });
    }

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

      // adminInfo (pool wallet address + balances) is for admins only — never expose to regular users.
      let adminInfo = {};
      if (role === 'admin' || role === 'superadmin') try {
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

    // Nothing has been submitted to the chain yet, so any failure from here to the
    // send() below is safe to roll back. Previously an unexpected throw (bad wallet
    // address, malformed payout config, RPC hiccup) escaped to the outer catch and
    // left the daily row inserted and the token stuck on 'reserved' forever — the
    // user burned their one spin of the day and could never retry.
    const releaseSpin = async () => {
      if (dailyRowId) await supabase.from('daily_spins').delete().eq('id', dailyRowId);
      await supabase
        .from('spin_tokens')
        .update({ status: 'issued', reserved_at: null })
        .eq('token', signedToken)
        .eq('server_id', server_id);
    };

    let idx, rewardDisplay, amountBase, tier, funding, ixs, sendCtx;
    try {
      idx = pickWeightedIndex(weights);
      rewardDisplay = Number(amounts[idx]);
      amountBase = toBaseUnits(amounts[idx], decimals);
      if (!Number.isFinite(amountBase) || amountBase < 0) {
        throw new Error(`Bad payout amount in wheel config: ${amounts[idx]}`);
      }
      tier = tierForAmount(amounts[idx], amounts);

      funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
      const userPk = new PublicKey(wallet_address);
      const mintPk = new PublicKey(contract_address);

      const fromATA = await getAssociatedTokenAddress(mintPk, funding.publicKey);
      const toATA = await getAssociatedTokenAddress(mintPk, userPk);

      // Check pool balance. Read inside the try (RPC may fail — then we just attempt
      // the transfer and handle failure), but act on the result outside it, so a
      // failing releaseSpin() can't be swallowed and let the payout continue.
      let poolBase = null;
      try {
        const balInfo = await connection.getTokenAccountBalance(fromATA, 'confirmed');
        const n = Number(balInfo?.value?.amount);
        poolBase = Number.isFinite(n) ? n : null;
      } catch {
        poolBase = null; // unknown → proceed and let the send surface any problem
      }
      if (poolBase !== null && poolBase < amountBase) {
        await releaseSpin();
        return res.status(503).json({ error: 'Prize pool is low. Please try again later.' });
      }

      // Build instructions with ATA create if needed
      ixs = [];
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

      sendCtx = { fromATA, toATA, mintPk, userPk };
    } catch (e) {
      console.error('[spin] pre-send failure:', e?.message || e);
      await releaseSpin();
      return res.status(500).json({ error: 'Could not prepare your spin. Please try again.' });
    }

    let signature;
    try {
      signature = await sendTxWithFreshBlockhash({
        connection,
        payer: funding,
        instructions: ixs,
        recentAccounts: [sendCtx.fromATA, sendCtx.toATA, sendCtx.mintPk, sendCtx.userPk.toBase58()],
        maxRetries: 4,
        commitment: 'confirmed',
      });
    } catch (e) {
      const code = e?.code;
      console.error('[spin] sendTx error:', code || '(none)', String(e?.message || e));

      if (code === 'PREFLIGHT' || code === 'ONCHAIN_FAIL') {
        // Definitely nothing moved → safe to release the daily slot for a clean retry.
        await releaseSpin();
        return res.status(502).json({ error: 'Token transfer failed. Please try again.' });
      }

      // Ambiguous (UNCONFIRMED): the transfer may have landed. Releasing the slot or
      // token here is exactly the double-payout hole. Lock it for manual review instead.
      await supabase.from('spin_tokens')
        .update({ status: 'review' })
        .eq('token', signedToken)
        .eq('server_id', server_id);
      if (dailyRowId) {
        await supabase.from('daily_spins')
          .update({ tx_signature: e?.signature || 'UNCONFIRMED', tier: 'review' })
          .eq('id', dailyRowId);
      }
      return res.status(502).json({
        error: 'Your spin is being processed. If you did not receive tokens, contact an admin.',
      });
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
      // Was `undefined` for normal users, which JSON drops entirely — so the page's
      // `typeof spins_left === 'number'` check failed and every player was told
      // "Unlimited spins" right after using their one spin of the day.
      spins_left: role === 'superadmin' ? 'Unlimited' : 0,
    });

  } catch (err) {
    console.error('[spin] Unhandled error:', err?.message || err);
    return res.status(500).json({ error: 'A server error occurred' });
  }
}
