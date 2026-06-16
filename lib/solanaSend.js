// /lib/solanaSend.js
import {
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';

/**
 * Sends an SPL transfer safely. The hard requirement here is: NEVER pay twice.
 *
 * The original version rebuilt a brand-new transaction (new blockhash) on every
 * retry. If a prior submission actually landed on-chain but the RPC timed out on
 * confirmation, the next retry sent a SECOND transfer with a still-valid window —
 * so two (or more) transfers could land. That is how a single spin could pay out
 * multiple times.
 *
 * Fix: a transaction is only ever re-signed once its blockhash has EXPIRED, at
 * which point the previous transaction can never land. While a blockhash is still
 * valid we do not resend a different transaction; if we can't confirm, we bail
 * with an UNCONFIRMED error and let the caller lock the spin for manual review
 * instead of releasing it for another attempt.
 *
 * Error codes on thrown errors:
 *   - 'PREFLIGHT'   : rejected before landing (no funds moved) — safe to retry/refund
 *   - 'ONCHAIN_FAIL': landed but failed (no funds moved)        — safe to retry/refund
 *   - 'UNCONFIRMED' : submitted, outcome unknown (may have paid) — do NOT retry/refund
 */
export async function sendTxWithFreshBlockhash({
  connection,
  payer,
  instructions,
  recentAccounts = [],
  maxRetries = 4,
  commitment = 'confirmed',
}) {
  // Best-effort account warm-up to reduce "could not find account" under load
  try {
    const addrs = []
      .concat(recentAccounts)
      .map((a) => (typeof a === 'string' ? a : a.toBase58?.() || String(a)))
      .filter(Boolean);
    if (addrs.length) {
      await connection.getMultipleAccountsInfo([...new Set(addrs)].map((a) => ({ toBase58: () => a })));
    }
  } catch {}

  const cuPrices = [2000, 5000, 25000, 50000];
  const cuLimits = [200000, 400000, 600000, 600000];

  let lastErr;

  for (let i = 0; i < Math.max(1, maxRetries); i++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash({ commitment });

    const ixBudget = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimits[Math.min(i, cuLimits.length - 1)] }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrices[Math.min(i, cuPrices.length - 1)] }),
    ];

    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ixBudget, ...instructions],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    // --- Submit ---
    let signature;
    try {
      signature = await connection.sendTransaction(tx, {
        skipPreflight: false, // surface simulation errors before anything is submitted
        maxRetries: 2,
        preflightCommitment: commitment,
      });
    } catch (e) {
      lastErr = e;
      const m = String(e?.message || e);
      // Transient RPC issues before the tx is accepted → safe to rebuild & retry.
      if (/Blockhash not found|Node is behind|429|Too Many Requests|temporary|timed out|fetch failed|ECONN|socket hang up/i.test(m)) {
        continue;
      }
      // Genuine preflight/simulation rejection → nothing moved.
      const err = new Error(`Transfer rejected at preflight: ${m}`);
      err.code = 'PREFLIGHT';
      throw err;
    }

    // --- Confirm (bounded by THIS blockhash's validity) ---
    try {
      const conf = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        commitment
      );
      if (conf?.value?.err) {
        const err = new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
        err.code = 'ONCHAIN_FAIL';
        throw err;
      }
      return signature; // success
    } catch (e) {
      if (e?.code === 'ONCHAIN_FAIL') throw e;
      lastErr = e;

      // Confirmation was ambiguous. Ask the chain directly what happened.
      try {
        const st = await connection.getSignatureStatuses([signature]);
        const info = st?.value?.[0];
        if (info) {
          if (info.err) {
            const err = new Error(`Transaction failed on-chain: ${JSON.stringify(info.err)}`);
            err.code = 'ONCHAIN_FAIL';
            throw err;
          }
          if (
            info.confirmationStatus === 'confirmed' ||
            info.confirmationStatus === 'finalized' ||
            (info.confirmations ?? 0) > 0
          ) {
            return signature; // it actually landed
          }
        }
      } catch (e2) {
        if (e2?.code === 'ONCHAIN_FAIL') throw e2;
      }

      // Not found yet. Is this blockhash still valid? If so, the submitted tx may
      // STILL land — re-signing now would risk a double payment. Bail ambiguous.
      let expired = false;
      try {
        const cur = await connection.getBlockHeight(commitment);
        expired = cur > lastValidBlockHeight;
      } catch {
        expired = false; // unknown → assume still live → do not resend
      }

      if (!expired) {
        const err = new Error('Transfer submitted but not yet confirmed');
        err.code = 'UNCONFIRMED';
        err.signature = signature;
        throw err;
      }
      // Blockhash expired AND signature not found → that tx can never land.
      // Safe to loop and rebuild with a fresh blockhash.
    }
  }

  // Exhausted retries. If the last failure was a clean preflight, surface that;
  // otherwise treat as ambiguous so the caller never auto-refunds a maybe-paid spin.
  if (lastErr?.code === 'PREFLIGHT' || lastErr?.code === 'ONCHAIN_FAIL') throw lastErr;
  const err = new Error('Transfer status unknown after retries');
  err.code = 'UNCONFIRMED';
  throw err;
}
