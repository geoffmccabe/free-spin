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
      console.error('FATAL: missing env (SUPABASE_URL / key / funding wallet / SPIN_KEY).');
      return res.status(500).json({ error: 'Server configuration error. Contact admin.' });
    }

    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { token: signedToken, spin, server_id } = req.body;
    if (!signedToken) return res.status(400).json({ error: 'Token required' });
    if (!server_id)   return res.status(400).json({ error: 'Server ID required' });

    // Verify signed link
    const [token, sigPart] = String(signedToken).split('.');
    if (!token || !sigPart) return res.status(400).json({ error: 'Invalid token format' });
    const expectedSignature = createHmac('sha256', SPIN_KEY).update(token).digest('hex');
    if (sigPart !== expectedSignature) return res.status(403).json({ error: 'Invalid or forged token' });

    // ***** ATOMIC CLAIM OF LINK (stops replay) *****
    // We flip used=false -> true in a single statement and read the row we claimed.
    let claim;
    {
      const { data, error } = await supabase
        .from('spin_tokens')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('token', signedToken)
        .eq('used', false)
        .select('discord_id, wallet_address, contract_address')
        .single();

      if (!data) {
        // Distinguish "already used" vs "invalid token"
        const { data: tRow } = await supabase
          .from('spin_tokens')
          .select('used')
          .eq('token', signedToken)
          .maybeSingle();

        if (!tRow) return res.status(400).json({ error: 'Invalid token' });
        return res.status(400).json({ error: 'This spin token has already been used' });
      }
      if (error) {
        console.error('Token claim error:', error.message);
        return res.status(500).json({ error: 'Failed to claim token' });
      }
      claim = data;
    }

    const { discord_id, wallet_address, contract_address } = claim;

    // Validate this mint belongs to the provided server (no need for spin_tokens.server_id)
    {
      const { data: serverTokens, error: serverTokenError } = await supabase
        .from('server_tokens')
        .select('contract_address, enabled')
        .eq('server_id', server_id);

      if (serverTokenError || !serverTokens?.some(t => t.contract_address === contract_address && t.enabled !== false)) {
        console.error(`Invalid contract_address ${contract_address} for server ${server_id}`);
        return res.status(400).json({ error: 'Invalid token for this server' });
      }
    }

    // Role + user limit
    const [{ data: userData, error: userError }, { data: adminData }] = await Promise.all([
      supabase.from('users').select('spin_limit').eq('discord_id', discord_id).single(),
      supabase.from('server_admins').select('role').eq('discord_id', discord_id).eq('server_id', server_id).single()
    ]);
    if (userError || !userData) return res.status(400).json({ error: 'User not found' });

    const role = adminData?.role || null;
    const isSuperadmin = role === 'superadmin';

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
      // Admin balances (best-effort)
      let adminInfo;
      if (role === 'admin' || role === 'superadmin') {
        try {
          const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
          const poolPubkey = fundingWallet.publicKey;

          let tokenAmt = 'N/A';
          try {
            const ata = await getAssociatedTokenAddress(new PublicKey(contract_address), poolPubkey);
            const bal = await connection.getTokenAccountBalance(ata);
            tokenAmt = bal.value.uiAmount;
          } catch {}

          let gasAmt = 'N/A';
          try {
            const lamports = await connection.getBalance(poolPubkey, 'processed');
            gasAmt = lamports / LAMPORTS_PER_SOL;
          } catch {}

          let tokenUsdValue = 'N/A';
          let gasUsdValue = 'N/A';
          if (COINMARKETCAP_API_KEY) {
            try {
              const g = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=SOL&convert=USD', { headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }});
              const gj = await g.json();
              const solPrice = gj?.data?.SOL?.quote?.USD?.price;
              if (typeof solPrice === 'number' && typeof gasAmt === 'number') gasUsdValue = (gasAmt * solPrice).toFixed(2);
            } catch {}
            try {
              const sym = String(config.token_name || '').toUpperCase().trim();
              if (sym) {
                const t = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(sym)}&convert=USD`, { headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }});
                const tj = await t.json();
                const price = tj?.data?.[sym]?.quote?.USD?.price;
                if (typeof price === 'number' && typeof tokenAmt === 'number') tokenUsdValue = (tokenAmt * price).toFixed(2);
              }
            } catch {}
          }

          adminInfo = {
            gasSymbol: 'SOL',
            gasAmt, gasUsdValue,
            tokenSymbol: config.token_name,
            tokenAmt, tokenUsdValue,
            poolAddr: poolPubkey.toString()
          };
        } catch {}
      }

      return res.status(200).json({
        tokenConfig: {
          token_name: config.token_name,
          payout_amounts: config.payout_amounts,
          image_url: config.image_url || 'https://solspin.lightningworks.io/img/Wheel_Generic_800px.webp'
        },
        spins_left: isSuperadmin ? 'Unlimited' : userData.spin_limit, // front-end will recompute after spin
        adminInfo,
        role,
        contract_address
      });
    }

    // ---------- DAILY LIMIT (24h) ----------
    let spins_left = userData.spin_limit;
    if (!isSuperadmin) {
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error: cntErr } = await supabase
        .from('daily_spins')
        .select('id', { count: 'exact', head: true })
        .eq('discord_id', discord_id)
        .gte('created_at_utc', sinceISO);
      if (cntErr) return res.status(500).json({ error: 'DB error checking spin history' });

      const used = count ?? 0;
      const limit = Number(userData.spin_limit ?? 0);
      if (used >= limit) return res.status(403).json({ error: 'Daily spin limit reached' });
      spins_left = Math.max(0, limit - used);
    } else {
      spins_left = 'Unlimited';
    }

    // ---------- RANDOM PICK ----------
    const weights = Array.isArray(config.payout_weights) && config.payout_weights.length === config.payout_amounts.length
      ? config.payout_weights
      : config.payout_amounts.map(() => 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const r = randomInt(0, totalWeight);
    let acc = 0, idx = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) { idx = i; break; } }
    const rewardAmount = Number(config.payout_amounts[idx]);
    const prizeText = `${rewardAmount} ${config.token_name}`;

    // ---------- TRANSFER ----------
    const fundingWallet = Keypair.fromSecretKey(Buffer.from(JSON.parse(FUNDING_WALLET_PRIVATE_KEY)));
    const userWallet = new PublicKey(wallet_address);
    const tokenMint = new PublicKey(contract_address);

    const fromTokenAddr = await getAssociatedTokenAddress(tokenMint, fundingWallet.publicKey);
    const toTokenAddr   = await getAssociatedTokenAddress(tokenMint, userWallet);

    const ixs = [];
    const [fromInfo, toInfo] = await Promise.all([
      connection.getAccountInfo(fromTokenAddr),
      connection.getAccountInfo(toTokenAddr)
    ]);
    if (!fromInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        fundingWallet.publicKey, fromTokenAddr, fundingWallet.publicKey, tokenMint
      ));
    }
    if (!toInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(
        fundingWallet.publicKey, toTokenAddr, userWallet, tokenMint
      ));
    }
    ixs.push(createTransferInstruction(
      fromTokenAddr, toTokenAddr, fundingWallet.publicKey, rewardAmount * (10 ** 5) // decimals=5
    ));

    const txSig = await sendTxWithFreshBlockhash({
      connection, payer: fundingWallet, instructions: ixs, recentAccounts: [], maxRetries: 4, commitment: 'confirmed'
    });

    // ---------- RECORD SPIN ----------
    const nowIso = new Date().toISOString();
    const { error: insertError } = await supabase.from('daily_spins').insert({
      discord_id,
      server_id,
      contract_address,
      wallet_address,
      reward: rewardAmount,
      amount_base: rewardAmount * (10 ** 5),
      signature: txSig,
      created_at_utc: nowIso
    });
    if (insertError) {
      console.error('Spin insert error:', insertError.message);
      // NOTE: token already claimed; transfer sent. We surface error to UI so you see it.
      return res.status(500).json({ error: 'Failed to record spin' });
    }

    // also store signature on the claimed link (optional bookkeeping)
    await supabase.from('spin_tokens').update({ signature: txSig }).eq('token', signedToken);

    return res.status(200).json({ segmentIndex: idx, prize: prizeText, spins_left });
  } catch (err) {
    console.error('API error:', err.message, err.stack);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}
