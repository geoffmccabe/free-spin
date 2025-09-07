import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getMint,
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
    COINMARKETCAP_API_KEY,
    SPIN_KEY,
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY || !SPIN_KEY) {
    console.error('FATAL: missing env');
    return res.status(500).json({ error: 'A server configuration error occurred. Please notify an administrator.' });
  }

  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { token: signedToken, spin, server_id } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // HMAC verify
    const [token, hsig] = String(signedToken).split('.');
    if (!token || !hsig) return res.status(400).json({ error: 'Invalid token format' });
    const expected = createHmac('sha256', SPIN_KEY).update(token).digest('hex');
    if (hsig !== expected) return res.status(403).json({ error: 'Invalid or forged token' });

    // Load spin token row
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, server_id, used')
      .eq('token', signedToken)
      .single();

    if (tokenErr || !tokenRow) return res.status(400).json({ error: 'Invalid token' });
    if (tokenRow.used) return res.status(400).json({ error: 'This spin token has already been used' });
    if (tokenRow.server_id !== server_id) return res.status(400).json({ error: 'Invalid token for this server' });

    const { discord_id, wallet_address, contract_address } = tokenRow;

    // Validate server + user + role
    const [
      { data: serverTokens, error: serverTokenError },
      { data: userData, error: userError },
      { data: adminData },
    ] = await Promise.all([
      supabase.from('server_tokens').select('contract_address').eq('server_id', server_id),
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single(),
    ]);

    if (serverTokenError || !serverTokens?.some(t => t.contract_address === contract_address)) {
      return res.status(400).json({ error: 'Invalid token for this server' });
    }
    if (userError || !userData) return res.status(400).json({ error: 'User not found' });

    const role = adminData?.role || null;
    const isSuperadmin = role === 'superadmin';

    // DAILY LIMIT — 1 per user per 24h (global, not per token)
    let spins_left = userData.spin_limit;
    if (!isSuperadmin) {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Prefer created_at_utc if the column exists; else fallback to created_at
      let used = 0;

      // attempt using created_at_utc
      let q = supabase
        .from('daily_spins')
        .select('id', { count: 'exact', head: true })
        .eq('discord_id', discord_id)
        .gte('created_at_utc', sinceISO);
      let resp = await q;
      if (resp.error?.message?.includes('column') || resp.error?.message?.includes('does not exist')) {
        // fallback to created_at
        resp = await supabase
          .from('daily_spins')
          .select('id', { count: 'exact', head: true })
          .eq('discord_id', discord_id)
          .gte('created_at', sinceISO);
      }
      if (resp.error) {
        console.error('Spin count error:', resp.error.message);
        return res.status(500).json({ error: 'DB error checking spin history' });
      }
      used = resp.count ?? 0;

      const limit = Number(userData.spin_limit ?? 0);
      if (used >= limit) return res.status(403).json({ error: 'Daily spin limit reached' });
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // Wheel config
    const { data: config, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !config) return res.status(400).json({ error: 'Invalid wheel configuration' });
    if (!Array.isArray(config.payout_amounts) || config.payout_amounts.length === 0) {
      return res.status(400).json({ error: 'No payout amounts configured.' });
    }

    // CONFIG PATH (page load)
    if (!spin) {
      let adminInfo = undefined;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const pool = fundingWallet.publicKey;

          let tokenAmt = 'N/A';
          try {
            const ata = await getAssociatedTokenAddress(new PublicKey(contract_address), pool);
            const bal = await connection.getTokenAccountBalance(ata);
            tokenAmt = bal.value.uiAmount;
          } catch {}

          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(pool, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch {}

          let tokenUsdValue = 'N/A';
          let gasUsdValue = 'N/A';
          if (COINMARKETCAP_API_KEY) {
            try {
              const r = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', {
                headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
              });
              const j = await r.json();
              const solPrice = j?.data?.SOL?.quote?.USD?.price;
              if (typeof solPrice === 'number' && typeof gasAmt === 'number') gasUsdValue = (gasAmt * solPrice).toFixed(2);
            } catch {}
            try {
              const sym = String(config.token_name || '').toUpperCase().trim();
              if (sym) {
                const r2 = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(sym)}&convert=USD`, {
                  headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
                });
                const j2 = await r2.json();
                const price = j2?.data?.[sym]?.quote?.USD?.price;
                if (typeof price === 'number' && typeof tokenAmt === 'number') tokenUsdValue = (tokenAmt * price).toFixed(2);
              }
            } catch {}
          }

          adminInfo = {
            gasSymbol: 'SOL',
            gasAmt,
            gasUsdValue,
            tokenSymbol: config.token_name,
            tokenAmt,
            tokenUsdValue,
            poolAddr: pool.toString(),
          };
        } catch (e) {
          console.error('Admin panel build failed', e?.message || e);
        }
      }

      const tokenConfig = {
        token_name: config.token_name,
        payout_amounts: config.payout_amounts,
        image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
      };

      return res.status(200).json({ tokenConfig, spins_left, adminInfo, role, contract_address });
    }

    // SPIN PATH
    const weights = Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
      ? config.payout_weights
      : config.payout_amounts.map(() => 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) { idx = i; break; } }

    const rewardAmount = Number(config.payout_amounts[idx]);
    const prizeText = `${rewardAmount} ${config.token_name}`;

    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    // decimals from chain (no hard-code)
    const mintInfo = await getMint(connection, tokenMint);
    const decimals = typeof mintInfo.decimals === 'number' ? mintInfo.decimals : 5;
    const amountBase = rewardAmount * (10 ** decimals);

    // ensure ATAs
    const fromATA = await getAssociatedTokenAddress(tokenMint, fundingWallet.publicKey);
    const toATA   = await getAssociatedTokenAddress(tokenMint, userWallet);
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA),
      connection.getAccountInfo(toATA),
    ]);

    const ixs = [];
    if (!fromInfo) ixs.push(createAssociatedTokenAccountInstruction(fundingWallet.publicKey, fromATA, fundingWallet.publicKey, tokenMint));
    if (!toInfo)   ixs.push(createAssociatedTokenAccountInstruction(fundingWallet.publicKey, toATA, userWallet, tokenMint));
    ixs.push(createTransferInstruction(fromATA, toATA, fundingWallet.publicKey, amountBase));

    // send + confirm
    const sig = await sendTxWithFreshBlockhash({
      connection,
      payer: fundingWallet,
      instructions: ixs,
      recentAccounts: [],
      maxRetries: 4,
      commitment: 'confirmed',
    });

    // write to DB — try modern schema first; fallback to legacy if columns missing
    const nowIso = new Date().toISOString();

    let insertErr = null;

    // Attempt modern insert
    {
      const { error } = await supabase.from('daily_spins').insert({
        discord_id,
        server_id,
        contract_address,
        reward: rewardAmount,          // display units
        amount_base: amountBase,       // base units (if column exists)
        signature: sig,
        created_at_utc: nowIso,        // if column exists
        wallet_address,                // if your table has it, fine; else ignored by DB
      });
      insertErr = error || null;
    }

    // Fallback to legacy schema on missing-column errors
    if (insertErr && /column .* does not exist|invalid input value/.test(insertErr.message)) {
      console.warn('Modern insert failed, falling back to legacy columns:', insertErr.message);
      const { error: legacyError } = await supabase.from('daily_spins').insert({
        discord_id,
        server_id,
        contract_address,
        reward: rewardAmount,
        signature: sig,
        created_at: nowIso,
      });
      if (legacyError) {
        console.error('Legacy insert also failed:', legacyError.message);
        return res.status(500).json({ error: 'Failed to record spin' });
      }
    } else if (insertErr) {
      console.error('Insert failed:', insertErr.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // burn link only after DB write succeeds
    await supabase.from('spin_tokens').update({ used: true, signature: sig }).eq('token', signedToken);

    return res.status(200).json({ segmentIndex: idx, prize: prizeText, spins_left });
  } catch (err) {
    console.error('API error:', err?.message || err, err?.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
