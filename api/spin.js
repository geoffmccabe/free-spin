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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --------- ENV ----------
  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    FUNDING_WALLET_PRIVATE_KEY,
    SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com',
    COINMARKETCAP_API_KEY,
    SPIN_KEY,
    SPIN_REQUIRE_HMAC, // set to "true" to enforce signature strictly
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FUNDING_WALLET_PRIVATE_KEY) {
    console.error('FATAL: Missing Supabase or funding wallet envs.');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { token: signedToken, spin, server_id } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // Split signed token
    const [prefixToken, suppliedSig] = String(signedToken).split('.', 2);

    // ---------- TOKEN LOOKUP (full signed first, then legacy prefix) ----------
    const tokenRow = await (async () => {
      // try exact (new)
      let { data, error } = await supabase
        .from('spin_tokens')
        .select('discord_id, wallet_address, contract_address, used, created_at')
        .eq('token', signedToken)
        .maybeSingle();
      if (error) {
        console.error('spin_tokens exact lookup error:', error.message);
      }
      if (data) return { row: data, matchType: 'exact' };

      // try legacy prefix
      if (prefixToken) {
        const { data: legacy, error: legacyErr } = await supabase
          .from('spin_tokens')
          .select('discord_id, wallet_address, contract_address, used, created_at')
          .eq('token', prefixToken)
          .maybeSingle();
        if (legacyErr) {
          console.error('spin_tokens prefix lookup error:', legacyErr.message);
        }
        if (legacy) return { row: legacy, matchType: 'prefix' };
      }
      return { row: null, matchType: null };
    })();

    if (!tokenRow.row) {
      // No DB record at all -> invalid link
      return res.status(400).json({ error: 'Invalid token' });
    }
    const { row: trow, matchType } = tokenRow;

    if (trow.used) {
      return res.status(400).json({ error: 'This spin token has already been used' });
    }
    const discord_id = trow.discord_id;
    const wallet_address = trow.wallet_address;
    const contract_address = trow.contract_address;

    // ---------- OPTIONAL HMAC CHECK ----------
    // Enforce HMAC only if explicitly required AND we have SPIN_KEY and signature part.
    if (SPIN_REQUIRE_HMAC === 'true') {
      if (!SPIN_KEY || !prefixToken || !suppliedSig) {
        return res.status(403).json({ error: 'Invalid or forged token' });
      }
      const expected = createHmac('sha256', SPIN_KEY).update(prefixToken).digest('hex');
      if (expected !== suppliedSig) {
        return res.status(403).json({ error: 'Invalid or forged token' });
      }
    }

    // ---------- Validate server+mint ----------
    const [
      { data: serverTokens, error: serverTokenError },
      { data: userData, error: userError },
      { data: adminData },
      { data: config, error: configError },
    ] = await Promise.all([
      supabase.from('server_tokens').select('contract_address, enabled').eq('server_id', server_id),
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).maybeSingle(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).maybeSingle(),
      supabase.from('wheel_configurations')
        .select('token_name, payout_amounts, payout_weights, image_url')
        .eq('contract_address', contract_address)
        .maybeSingle(),
    ]);

    if (serverTokenError || !serverTokens?.some(s => s.contract_address === contract_address && (s.enabled ?? true))) {
      console.error(`Mint ${contract_address} not enabled for server ${server_id}`);
      return res.status(400).json({ error: 'Invalid token for this server' });
    }
    if (userError || !userData) {
      console.error(`User not found for discord_id=${discord_id}`);
      return res.status(400).json({ error: 'User not found' });
    }
    if (configError || !config || !Array.isArray(config.payout_amounts) || config.payout_amounts.length === 0) {
      console.error(`Wheel config missing for mint ${contract_address}`);
      return res.status(400).json({ error: 'Invalid wheel configuration' });
    }

    const role = adminData?.role || null;
    const isSuperadmin = role === 'superadmin';

    // ---------- PAGE LOAD (no spin): return config + admin panel data ----------
    if (!spin) {
      const tokenConfig = {
        token_name: config.token_name,
        payout_amounts: config.payout_amounts,
        image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
      };

      // Daily limit calc (for display)
      let spins_left = userData.spin_limit;
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
          console.error('spin count error:', cntErr.message);
        }
        const used = count ?? 0;
        const limit = Number(userData.spin_limit ?? 0);
        spins_left = used >= limit ? 0 : (limit - used);
      } else {
        spins_left = 'Unlimited';
      }

      // Admin info (best-effort)
      let adminInfo;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const poolPubkey = fundingWallet.publicKey;
          const mint = new PublicKey(contract_address);

          let tokenAmt = 'N/A';
          try {
            const ata = await getAssociatedTokenAddress(mint, poolPubkey);
            const bal = await connection.getTokenAccountBalance(ata);
            tokenAmt = bal.value.uiAmount;
          } catch (e) {
            console.error('SPL balance fetch failed', e);
          }

          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(poolPubkey, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch (e) {
            console.error('SOL balance fetch failed', e);
          }

          let tokenUsdValue = 'N/A';
          let gasUsdValue = 'N/A';
          if (COINMARKETCAP_API_KEY) {
            try {
              const gasRes = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', {
                headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY },
              });
              const gasJson = await gasRes.json();
              const solPrice = gasJson?.data?.SOL?.quote?.USD?.price;
              if (typeof solPrice === 'number' && typeof gasAmt === 'number') {
                gasUsdValue = (gasAmt * solPrice).toFixed(2);
              }
            } catch (e) {
              console.error('SOL price fetch failed', e);
            }

            try {
              const sym = String(config.token_name || '').toUpperCase().trim();
              if (sym) {
                const tokRes = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(sym)}&convert=USD`, {
                  headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY },
                });
                const tokJson = await tokRes.json();
                const price = tokJson?.data?.[sym]?.quote?.USD?.price;
                if (typeof price === 'number' && typeof tokenAmt === 'number') {
                  tokenUsdValue = (tokenAmt * price).toFixed(2);
                }
              }
            } catch (e) {
              console.error('Spin token price fetch failed', e);
            }
          }

          adminInfo = {
            gasSymbol: 'SOL',
            gasAmt,
            gasUsdValue,
            tokenSymbol: config.token_name,
            tokenAmt,
            tokenUsdValue,
            poolAddr: poolPubkey.toString(),
          };
        } catch (e) {
          console.error('Admin panel build failed', e);
        }
      }

      return res.status(200).json({
        tokenConfig,
        spins_left,
        adminInfo,
        role,
        contract_address,
        token_match_type: matchType, // helps debug legacy vs exact
      });
    }

    // ---------- SPIN PATH ----------
    const weights = Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
      ? config.payout_weights
      : config.payout_amounts.map(() => 1);

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let sum = 0, selectedIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (r < sum) { selectedIndex = i; break; }
    }

    const rewardAmount = Number(config.payout_amounts[selectedIndex]);
    const prizeText = `${rewardAmount} ${config.token_name}`;

    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const payer = fundingWallet.publicKey;
    const fromToken = await getAssociatedTokenAddress(tokenMint, payer);
    const toToken   = await getAssociatedTokenAddress(tokenMint, userWallet);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromToken),
      connection.getAccountInfo(toToken),
    ]);
    if (!fromInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(payer, fromToken, payer, tokenMint));
    }
    if (!toInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(payer, toToken, userWallet, tokenMint));
    }
    ixs.push(
      createTransferInstruction(
        fromToken,
        toToken,
        payer,
        rewardAmount * (10 ** 5) // your mint has 5 decimals
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

    // Write spin row — prefer created_at_utc; gracefully fall back if needed
    const nowIso = new Date().toISOString();
    let insertErr = null;
    let insertDone = false;

    // Try modern schema first
    let resp = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      contract_address,
      reward: rewardAmount,               // legacy display units (kept for history)
      amount_base: rewardAmount * (10 ** 5),
      signature: sig,
      created_at_utc: nowIso,
    });
    insertErr = resp.error;
    insertDone = !resp.error;

    // Fallback for older schema (no created_at_utc/amount_base)
    if (!insertDone) {
      console.warn('Insert (new schema) failed:', insertErr?.message);
      const resp2 = await supabase.from('daily_spins').insert({
        discord_id,
        server_id,
        contract_address,
        reward: rewardAmount,
        signature: sig,
        created_at: nowIso,
      });
      if (resp2.error) {
        console.error('Insert (legacy fallback) also failed:', resp2.error.message);
        return res.status(500).json({ error: 'Failed to record spin' });
      }
    }

    // Burn this link now that the spin succeeded
    const burn = await supabase.from('spin_tokens')
      .update({ used: true, signature: sig })
      .eq('token', matchType === 'exact' ? signedToken : prefixToken);
    if (burn.error) console.error('spin_tokens update failed:', burn.error.message);

    return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText, spins_left: isSuperadmin ? 'Unlimited' : (userData.spin_limit - 1) });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
