import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
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
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { token: signedToken, spin, server_id } = req.body || {};
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // Verify HMAC token
    const [token, signaturePart] = String(signedToken).split('.');
    if (!token || !signaturePart) return res.status(400).json({ error: 'Invalid token format' });
    const expectedSignature = createHmac('sha256', SPIN_KEY).update(token).digest('hex');
    if (signaturePart !== expectedSignature) return res.status(403).json({ error: 'Invalid or forged token' });

    // Lookup token row (stored as full signed token)
    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .single();

    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });
    if (tokenData.used) return res.status(400).json({ error: 'This spin token has already been used' });

    const { discord_id, wallet_address, contract_address } = tokenData;

    // Validate token belongs to this server via server_tokens list
    const { data: serverTokens, error: serverTokenError } = await supabase
      .from('server_tokens')
      .select('contract_address')
      .eq('server_id', server_id);

    if (serverTokenError || !serverTokens?.some(t => t.contract_address === contract_address)) {
      console.error(`Invalid contract_address ${contract_address} for server ${server_id}`);
      return res.status(400).json({ error: 'Invalid token for this server' });
    }

    // User spin limit & role
    const [{ data: userData, error: userError }, { data: adminData }] = await Promise.all([
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single(),
    ]);

    if (userError || !userData) return res.status(400).json({ error: 'User not found' });

    const role = adminData?.role || null; // 'admin' | 'superadmin' | null
    const isSuperadmin = role === 'superadmin';

    // Daily limit (last 24h) per user+server+mint
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
        console.error(`Spin count error: ${cntErr.message}`);
        return res.status(500).json({ error: 'DB error checking spin history' });
      }

      const used = count ?? 0;
      const limit = Number(userData.spin_limit ?? 0);
      if (used >= limit) return res.status(403).json({ error: 'Daily spin limit reached' });
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // Load wheel config
    const { data: config, error: configError } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (configError || !config) return res.status(400).json({ error: 'Invalid wheel configuration' });
    if (!Array.isArray(config.payout_amounts) || config.payout_amounts.length === 0) {
      return res.status(400).json({ error: 'No payout amounts configured.' });
    }

    // ---------- CONFIG PATH ----------
    if (!spin) {
      const tokenConfig = {
        token_name: config.token_name,
        payout_amounts: config.payout_amounts,
        image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
      };

      let adminInfo = undefined;
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
          } catch (e) {
            console.error('SPL balance fetch failed', e);
          }

          // SOL balance (gas)
          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(poolPubkey, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch (e) {
            console.error('SOL balance fetch failed', e);
          }

          // USD values (best-effort)
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
            } catch (e) {
              console.error('SOL price fetch failed', e);
            }

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
      });
    }

    // ---------- SPIN PATH ----------
    const weights =
      Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
        ? config.payout_weights
        : config.payout_amounts.map(() => 1);

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const rnd = randomInt(0, totalWeight);
    let sum = 0;
    let selectedIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (rnd < sum) { selectedIndex = i; break; }
    }

    const rewardAmount = Number(config.payout_amounts[selectedIndex]); // display units
    const amountBase = rewardAmount * (10 ** 5);                       // 5 decimals as per your mint
    const prizeText = `${rewardAmount} ${config.token_name}`;

    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const fromTokenAddr = await getAssociatedTokenAddress(tokenMint, fundingWallet.publicKey);
    const toTokenAddr = await getAssociatedTokenAddress(tokenMint, userWallet);

    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromTokenAddr),
      connection.getAccountInfo(toTokenAddr),
    ]);

    const instructions = [];

    if (!fromInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fundingWallet.publicKey, fromTokenAddr, fundingWallet.publicKey, tokenMint
        )
      );
    }
    if (!toInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fundingWallet.publicKey, toTokenAddr, userWallet, tokenMint
        )
      );
    }

    instructions.push(
      createTransferInstruction(fromTokenAddr, toTokenAddr, fundingWallet.publicKey, amountBase)
    );

    const sig = await sendTxWithFreshBlockhash({
      connection,
      payer: fundingWallet,
      instructions,
      recentAccounts: [],
      maxRetries: 4,
      commitment: 'confirmed',
    });

    // Record spin (omit created_at_utc; your trigger handles timestamps)
    const { error: insertErr } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      contract_address,
      reward: rewardAmount,   // legacy display units
      amount_base: amountBase,
      signature: sig,
    });

    if (insertErr) {
      console.error('Insert failed:', insertErr.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // Burn the link only after DB write succeeds
    await supabase.from('spin_tokens').update({ used: true, signature: sig }).eq('token', signedToken);

    return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText, spins_left });
  } catch (err) {
    console.error('API error:', err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
