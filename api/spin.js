import { createClient } from '@supabase/supabase-js';
import {
  Connection, PublicKey, Keypair, Transaction, LAMPORTS_PER_SOL, ComputeBudgetProgram
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount, createTransferInstruction, getAssociatedTokenAddress
} from '@solana/spl-token';
import { createHmac, randomInt } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUNDING_WALLET_PRIVATE_KEY = process.env.FUNDING_WALLET_PRIVATE_KEY;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY;

const connection = new Connection(SOLANA_RPC_URL, { commitment: 'processed' });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchServerTokens(server_id) {
  // Try to read `enabled`; if the column doesn't exist, fall back to just `contract_address`
  let tokens = [];
  try {
    const { data, error } = await supabase
      .from('server_tokens')
      .select('contract_address, enabled')
      .eq('server_id', server_id);
    if (error) throw error;
    tokens = data || [];
  } catch (e) {
    const msg = ((e?.message || '') + ' ' + (e?.details || '')).toLowerCase();
    if (msg.includes('enabled')) {
      const fb = await supabase
        .from('server_tokens')
        .select('contract_address')
        .eq('server_id', server_id);
      if (fb.error) throw fb.error;
      tokens = (fb.data || []).map(r => ({ contract_address: r.contract_address, enabled: true }));
    } else {
      throw e;
    }
  }
  return tokens;
}

async function sendWithRetryAndHTTPConfirm(connection, tx, signer, { maxWaitMs = 6000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'processed',
      maxRetries: 5,
    });

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const st = await connection.getSignatureStatuses([sig]);
      const info = st?.value?.[0] || null;
      if (info?.err) { lastErr = new Error(`Transaction failed: ${JSON.stringify(info.err)}`); break; }
      if (info?.confirmationStatus === 'confirmed' || info?.confirmationStatus === 'finalized') return sig;

      const currentBH = await connection.getBlockHeight('processed');
      if (currentBH > lastValidBlockHeight) { lastErr = new Error('Blockheight exceeded'); break; }
      await sleep(400);
    }
    if (!lastErr) lastErr = new Error('Confirm timeout; retrying with fresh blockhash.');
    // loop to retry once
  }
  throw lastErr || new Error('Failed to confirm transaction.');
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token: signedToken, spin, server_id } = req.body;
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id) return res.status(400).json({ error: 'Server ID required' });

    const TOKEN_SECRET = process.env.SPIN_KEY;
    if (!TOKEN_SECRET) {
      console.error("FATAL: SPIN_KEY environment variable not found or is empty.");
      return res.status(500).json({ error: 'A server configuration error occurred. Please notify an administrator.' });
    }

    const [token, signaturePart] = String(signedToken).split('.');
    if (!token || !signaturePart) {
      console.error(`Malformed token: ${signedToken}`);
      return res.status(400).json({ error: 'Invalid token format' });
    }
    const expectedSignature = createHmac('sha256', TOKEN_SECRET).update(token).digest('hex');
    if (signaturePart !== expectedSignature) {
      console.error(`Invalid signature for token: ${token}`);
      return res.status(403).json({ error: 'Invalid or forged token' });
    }

    const { data: tokenData, error: tokenError } = await supabase
      .from('spin_tokens')
      .select('discord_id, wallet_address, contract_address, used')
      .eq('token', signedToken)
      .single();

    if (tokenError || !tokenData) return res.status(400).json({ error: 'Invalid token' });
    if (tokenData.used) return res.status(400).json({ error: 'This spin token has already been used' });

    const { discord_id, wallet_address, contract_address } = tokenData;

    // >>> Robust server token fetch (tolerates missing `enabled` column)
    let serverTokens = [];
    try {
      serverTokens = await fetchServerTokens(server_id);
    } catch (e) {
      console.error('server_tokens fetch error:', e?.message || e);
      return res.status(400).json({ error: 'Invalid token for this server' });
    }

    if (!serverTokens?.some(t => String(t.contract_address).trim() === String(contract_address).trim())) {
      console.error(`Invalid contract_address ${contract_address} for server ${server_id}`);
      return res.status(400).json({ error: 'Invalid token for this server' });
    }

    // user & role
    const [{ data: userData, error: userError }, { data: adminData }] = await Promise.all([
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single()
    ]);

    if (userError || !userData) return res.status(400).json({ error: 'User not found' });
    const role = adminData?.role || null;
    const isSuperadmin = role === 'superadmin';

    // spin limit (non-superadmin)
    let spins_left = userData.spin_limit;
    if (!isSuperadmin) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSpins, error: spinCountError } = await supabase
        .from('daily_spins')
        .select('contract_address')
        .eq('discord_id', discord_id)
        .gte('created_at', since);

      if (spinCountError) return res.status(500).json({ error: 'DB error checking spin history' });

      const used = recentSpins?.length || 0;
      const limit = Number(userData.spin_limit ?? 0);
      if (used >= limit) return res.status(403).json({ error: 'Daily spin limit reached' });
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // wheel config
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
        image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp'
      };

      let adminInfo = undefined;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const poolPubkey = fundingWallet.publicKey;

          // SPL balance
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

          // USD (best effort)
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
          console.error('Admin panel build failed', e);
        }
      }

      return res.status(200).json({
        tokenConfig,
        spins_left,
        adminInfo,
        role,
        contract_address
      });
    }

    // ---------- SPIN PATH ----------
    const weights = Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
      ? config.payout_weights
      : config.payout_amounts.map(() => 1);

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const rand = randomInt(0, totalWeight);
    let sum = 0;
    let selectedIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (rand < sum) { selectedIndex = i; break; }
    }

    const rewardAmount = Number(config.payout_amounts[selectedIndex]);
    const prizeText = `${rewardAmount} ${config.token_name}`;

    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(connection, fundingWallet, tokenMint, fundingWallet.publicKey);
    const toTokenAccount = await getOrCreateAssociatedTokenAccount(connection, fundingWallet, tokenMint, userWallet);

    const buildTx = () => {
      const tx = new Transaction();
      // Priority fee & compute limit for faster inclusion
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }));
      tx.add(createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fundingWallet.publicKey,
        rewardAmount * (10 ** 5)
      ));
      return tx;
    };

    let finalSig;
    try {
      finalSig = await sendWithRetryAndHTTPConfirm(connection, buildTx(), fundingWallet, { maxWaitMs: 6000 });
    } catch (err) {
      finalSig = await sendWithRetryAndHTTPConfirm(connection, buildTx(), fundingWallet, { maxWaitMs: 6000 });
    }

    await supabase.from('daily_spins').insert({ discord_id, reward: rewardAmount, contract_address, signature: finalSig });
    await supabase.from('spin_tokens').update({ used: true, signature: finalSig }).eq('token', signedToken);

    return res.status(200).json({ segmentIndex: selectedIndex, prize: prizeText, spins_left });
  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
