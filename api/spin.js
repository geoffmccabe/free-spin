// /api/spin.js
import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
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
      console.error('FATAL: Missing required environment variables.');
      return res.status(500).json({ error: 'A server configuration error occurred. Please notify an administrator.' });
    }

    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { token: signedToken, spin, server_id } = req.body;
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // ---- Verify signed token (HMAC) ----
    const [token, signaturePart] = String(signedToken).split('.');
    if (!token || !signaturePart) {
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const expectedSignature = createHmac('sha256', SPIN_KEY).update(token).digest('hex');
    if (signaturePart !== expectedSignature) {
      return res.status(403).json({ error: 'Invalid or forged token' });
    }

    // ---- ATOMIC CLAIM: burn the token in one statement (prevents race) ----
    // The link must match the exact signed token, must be unused, and must belong to this server.
    const { data: claim, error: claimErr } = await supabase
      .from('spin_tokens')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', signedToken)
      .eq('used', false)
      .eq('server_id', server_id)
      .select('discord_id,wallet_address,contract_address,server_id')
      .single();

    if (claimErr) {
      console.error('Token claim error:', claimErr.message);
      return res.status(400).json({ error: 'Invalid token' });
    }
    if (!claim) {
      // Either wrong server, already used, or doesn’t exist.
      return res.status(400).json({ error: 'This spin token has already been used or is invalid for this server' });
    }

    const { discord_id, wallet_address, contract_address } = claim;

    // ---- Validate token belongs to enabled token set for this server ----
    const [{ data: serverTokens, error: stErr }] = await Promise.all([
      supabase.from('server_tokens').select('contract_address, enabled').eq('server_id', server_id),
    ]);
    if (stErr || !serverTokens?.some(t => t.contract_address === contract_address && t.enabled !== false)) {
      return res.status(400).json({ error: 'Invalid token for this server' });
    }

    // ---- Get user spin limit & role ----
    const [{ data: userData, error: userErr }, { data: adminData }] = await Promise.all([
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single()
    ]);
    if (userErr || !userData) {
      return res.status(400).json({ error: 'User not found' });
    }
    const role = adminData?.role || null; // 'admin' | 'superadmin' | null
    const isSuperadmin = role === 'superadmin';

    // ---- Load wheel config ----
    const { data: config, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url, decimals')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !config) return res.status(400).json({ error: 'Invalid wheel configuration' });
    if (!Array.isArray(config.payout_amounts) || config.payout_amounts.length === 0) {
      return res.status(400).json({ error: 'No payout amounts configured.' });
    }
    const tokenDecimals = Number(config.decimals ?? 5);

    // ---- CONFIG PATH (page load) ----
    if (!spin) {
      // Admin panel info (optional, best-effort)
      let adminInfo;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const poolPubkey = fundingWallet.publicKey;

          // SPL token balance
          let tokenAmt = 'N/A';
          try {
            const ata = await getAssociatedTokenAddress(new PublicKey(contract_address), poolPubkey);
            const balanceResponse = await connection.getTokenAccountBalance(ata);
            tokenAmt = balanceResponse.value.uiAmount;
          } catch (e) { console.error('SPL balance fetch failed', e); }

          // SOL balance
          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(poolPubkey, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch (e) { console.error('SOL balance fetch failed', e); }

          // USD estimates (best-effort via CMC)
          let tokenUsdValue = 'N/A';
          let gasUsdValue = 'N/A';
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
            } catch (e) { console.error('SOL price fetch failed', e); }

            try {
              const sym = String(config.token_name || '').toUpperCase().trim();
              if (sym) {
                const tokRes = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(sym)}&convert=USD`, {
                  headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
                });
                const tokJson = await tokRes.json();
                const price = tokJson?.data?.[sym]?.quote?.USD?.price;
                if (typeof price === 'number' && typeof tokenAmt === 'number') {
                  tokenUsdValue = (tokenAmt * price).toFixed(2);
                }
              }
            } catch (e) { console.error('Spin token price fetch failed', e); }
          }

          adminInfo = {
            gasSymbol: 'SOL',
            gasAmt,
            gasUsdValue,
            tokenSymbol: config.token_name,
            tokenAmt,
            tokenUsdValue,
            poolAddr: poolPubkey.toString()
          };
        } catch (e) {
          console.error('Admin info build failed', e);
        }
      }

      // spins_left (use 24h rolling window); superadmin bypasses
      let spins_left = 'Unlimited';
      if (!isSuperadmin) {
        const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count, error: cntErr } = await supabase
          .from('daily_spins')
          .select('id', { count: 'exact', head: true })
          .eq('discord_id', discord_id)
          .eq('server_id', server_id)
          .eq('contract_address', contract_address)
          .gte('created_at_utc', sinceISO);

        if (cntErr) {
          console.error(`Spin count error: ${cntErr.message}`);
          return res.status(500).json({ error: 'DB error checking spin history' });
        }
        const used = count ?? 0;
        const limit = Number(userData.spin_limit ?? 0);
        if (used >= limit) {
          return res.status(403).json({ error: 'Daily spin limit reached' });
        }
        spins_left = Math.max(0, limit - used);
      }

      return res.status(200).json({
        tokenConfig: {
          token_name: config.token_name,
          payout_amounts: config.payout_amounts,
          image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp'
        },
        spins_left,
        adminInfo,
        role,
        contract_address
      });
    }

    // ---- SPIN PATH ----
    // Choose reward by server-side weights
    const weights = Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
      ? config.payout_weights
      : config.payout_amounts.map(() => 1);

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const rnd = randomInt(0, totalWeight);
    let sum = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (rnd < sum) { idx = i; break; }
    }

    const rewardAmount = Number(config.payout_amounts[idx]);
    const prizeText = `${rewardAmount} ${config.token_name}`;
    const amountBase = BigInt(Math.round(rewardAmount * (10 ** tokenDecimals)));

    // Send SPL transfer (create ATAs if needed)
    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const fromTokenAddr = await getAssociatedTokenAddress(tokenMint, fundingWallet.publicKey);
    const toTokenAddr = await getAssociatedTokenAddress(tokenMint, userWallet);

    const ixs = [];

    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromTokenAddr),
      connection.getAccountInfo(toTokenAddr)
    ]);

    if (!fromInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          fundingWallet.publicKey, fromTokenAddr, fundingWallet.publicKey, tokenMint
        )
      );
    }
    if (!toInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          fundingWallet.publicKey, toTokenAddr, userWallet, tokenMint
        )
      );
    }

    ixs.push(
      createTransferInstruction(
        fromTokenAddr,
        toTokenAddr,
        fundingWallet.publicKey,
        Number(amountBase) // spl-token lib expects number; safe for 10^5 scale here
      )
    );

    const sig = await sendTxWithFreshBlockhash({
      connection,
      payer: fundingWallet,
      instructions: ixs,
      recentAccounts: [],
      maxRetries: 4,
      commitment: 'confirmed',
    });

    // Record the spin
    const { error: insertErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      contract_address,
      wallet_address,
      reward: rewardAmount,
      amount_base: Number(amountBase),
      signature: sig,
      created_at_utc: new Date().toISOString()
    });
    if (insertErr) {
      console.error('Insert failed:', insertErr.message);
      // We already burned the link and sent the payout; surface a clear message so you can see it in logs.
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    return res.status(200).json({ segmentIndex: idx, prize: prizeText, spins_left: isSuperadmin ? 'Unlimited' : undefined });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
