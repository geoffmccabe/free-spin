import { createClient } from '@supabase/supabase-js';
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { createHmac, randomInt } from 'crypto';

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
    console.error('FATAL env missing');
    return res.status(500).json({ error: 'Server configuration error. Missing env.' });
  }

  const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = req.body || {};
    const { token: signedToken, spin, server_id } = body;
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // 1) Verify HMAC (matches how your bot signs page links)
    const [tokenPart, tokenSig] = String(signedToken).split('.');
    if (!tokenPart || !tokenSig) return res.status(400).json({ error: 'Invalid token format' });
    const expected = createHmac('sha256', SPIN_KEY).update(tokenPart).digest('hex');
    if (tokenSig !== expected) return res.status(403).json({ error: 'Invalid or forged token' });

    // 2) Fetch the spin token row — try FULL token first, then fall back to bare token
    let tokenRow = null;
    {
      const { data, error } = await supabase
        .from('spin_tokens')
        .select('discord_id, wallet_address, contract_address, server_id, used')
        .eq('token', signedToken)
        .single();
      if (!error && data) tokenRow = data;
    }
    if (!tokenRow) {
      const { data, error } = await supabase
        .from('spin_tokens')
        .select('discord_id, wallet_address, contract_address, server_id, used')
        .eq('token', tokenPart)
        .single();
      if (!error && data) tokenRow = data;
    }

    if (!tokenRow) return res.status(400).json({ error: 'Invalid token' });
    if (tokenRow.used) return res.status(400).json({ error: 'This spin token has already been used' });

    // If token row has a server_id, enforce it; if null/empty, let server validation below decide
    if (tokenRow.server_id && tokenRow.server_id !== server_id) {
      return res.status(400).json({ error: 'Invalid token for this server' });
    }

    const { discord_id, wallet_address, contract_address } = tokenRow;

    // 3) Validate the server/mint and read user role/limit
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

    // 4) Global 24h limit per user (superadmin bypasses)
    let spins_left = userData.spin_limit;
    if (!isSuperadmin) {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Prefer created_at_utc if exists; fallback to created_at
      let cntResp = await supabase
        .from('daily_spins')
        .select('id', { head: true, count: 'exact' })
        .eq('discord_id', discord_id)
        .gte('created_at_utc', sinceISO);

      if (cntResp.error && /column .* does not exist/i.test(cntResp.error.message)) {
        cntResp = await supabase
          .from('daily_spins')
          .select('id', { head: true, count: 'exact' })
          .eq('discord_id', discord_id)
          .gte('created_at', sinceISO);
      }
      if (cntResp.error) {
        console.error('Spin count error:', cntResp.error.message);
        return res.status(500).json({ error: 'DB error checking spin history' });
      }

      const used = cntResp.count ?? 0;
      const limit = Number(userData.spin_limit ?? 0);
      if (used >= limit) return res.status(403).json({ error: 'Daily spin limit reached' });
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // 5) Load wheel config
    const { data: cfg, error: cfgErr } = await supabase
      .from('wheel_configurations')
      .select('token_name, payout_amounts, payout_weights, image_url')
      .eq('contract_address', contract_address)
      .single();

    if (cfgErr || !cfg) return res.status(400).json({ error: 'Invalid wheel configuration' });
    if (!Array.isArray(cfg.payout_amounts) || cfg.payout_amounts.length === 0) {
      return res.status(400).json({ error: 'No payout amounts configured.' });
    }

    // 6) CONFIG path (initial page load)
    if (!spin) {
      let adminInfo;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const pool = funding.publicKey;

          // SPL token balance
          let tokenAmt = 'N/A';
          try {
            const ata = await getAssociatedTokenAddress(new PublicKey(contract_address), pool);
            const bal = await connection.getTokenAccountBalance(ata);
            tokenAmt = bal.value.uiAmount;
          } catch {}

          // SOL balance (gas)
          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(pool, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch {}

          // USD values (best-effort)
          let tokenUsdValue = 'N/A';
          let gasUsdValue = 'N/A';
          if (COINMARKETCAP_API_KEY) {
            try {
              const r = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', {
                headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
              });
              const j = await r.json();
              const sol = j?.data?.SOL?.quote?.USD?.price;
              if (typeof sol === 'number' && typeof gasAmt === 'number') gasUsdValue = (gasAmt * sol).toFixed(2);
            } catch {}
            try {
              const sym = String(cfg.token_name || '').toUpperCase();
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
            tokenSymbol: cfg.token_name,
            tokenAmt,
            tokenUsdValue,
            poolAddr: pool.toString(),
          };
        } catch (e) {
          console.error('Admin info error:', e?.message || e);
        }
      }

      const tokenConfig = {
        token_name: cfg.token_name,
        payout_amounts: cfg.payout_amounts,
        image_url: cfg.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp',
      };

      return res.status(200).json({ tokenConfig, spins_left, adminInfo, role, contract_address });
    }

    // 7) SPIN path
    const weights = Array.isArray(cfg.payout_weights) && cfg.payout_weights.length === cfg.payout_amounts.length
      ? cfg.payout_weights
      : cfg.payout_amounts.map(() => 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let sum = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) { sum += weights[i]; if (r < sum) { idx = i; break; } }

    const rewardAmount = Number(cfg.payout_amounts[idx]);
    const prizeText = `${rewardAmount} ${cfg.token_name}`;

    const funding = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const user = new PublicKey(wallet_address);
    const mint = new PublicKey(contract_address);

    // default decimals=5 (HAROLD/FATCOIN); avoids RPC metadata call
    const decimals = 5;
    const amountBase = BigInt(rewardAmount) * BigInt(10 ** decimals);

    const fromATA = await getAssociatedTokenAddress(mint, funding.publicKey);
    const toATA   = await getAssociatedTokenAddress(mint, user);

    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromATA),
      connection.getAccountInfo(toATA),
    ]);

    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
    ];
    if (!fromInfo) ixs.push(createAssociatedTokenAccountInstruction(funding.publicKey, fromATA, funding.publicKey, mint));
    if (!toInfo)   ixs.push(createAssociatedTokenAccountInstruction(funding.publicKey, toATA, user, mint));
    ixs.push(createTransferInstruction(fromATA, toATA, funding.publicKey, Number(amountBase)));

    // Send with fresh blockhash + confirm + transient retry
    let signature = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({
          payerKey: funding.publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msg);
        vtx.sign([funding]);

        signature = await connection.sendTransaction(vtx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 2,
        });

        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        break;
      } catch (e) {
        lastErr = e;
        const m = String(e?.message || e);
        if (
          m.includes('block height exceeded') ||
          m.includes('expired') ||
          m.includes('BlockhashNotFound') ||
          m.includes('socket hang up') ||
          m.includes('ECONNRESET') ||
          m.includes('429')
        ) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        throw e;
      }
    }
    if (!signature) {
      console.error('Send failed:', lastErr?.message || lastErr);
      return res.status(500).json({ error: 'Failed to send transfer' });
    }

    // 8) Record spin — try modern columns first; fallback to legacy names
    const nowIso = new Date().toISOString();

    let insertError = null;
    {
      const { error } = await supabase.from('daily_spins').insert({
        discord_id,
        server_id,
        contract_address,
        wallet_address,
        reward: rewardAmount,              // display units
        amount_base: Number(amountBase),   // base units
        signature,
        created_at_utc: nowIso,
      });
      insertError = error || null;
    }
    if (insertError && /column .* does not exist/i.test(insertError.message)) {
      // legacy fallback
      const { error: legacyErr } = await supabase.from('daily_spins').insert({
        discord_id,
        server_id,
        contract_address,
        reward: rewardAmount,
        signature,
        created_at: nowIso,
      });
      if (legacyErr) {
        console.error('Legacy insert failed:', legacyErr.message);
        return res.status(500).json({ error: 'Failed to record spin' });
      }
    } else if (insertError) {
      console.error('Insert failed:', insertError.message);
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // Burn token only after DB insert succeeds
    await supabase.from('spin_tokens').update({ used: true, signature }).eq('token', signedToken).or(`token.eq.${tokenPart}`);

    return res.status(200).json({ segmentIndex: idx, prize: prizeText, spins_left });
  } catch (err) {
    console.error('API error:', err?.message || err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
