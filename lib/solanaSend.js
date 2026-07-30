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
 * A second hole existed on the SUBMIT path: a network-level failure ("timed out",
 * "fetch failed", "socket hang up") was treated as transient and the loop rebuilt a
 * brand-new transaction. But a network error on the response can mean the request
 * WAS delivered — so that retry could double-pay too. We now derive the signature
 * locally from the signed transaction BEFORE submitting, so on any ambiguous send
 * failure we ask the chain what happened to that exact signature instead of
 * guessing. Only an error that proves nothing was submitted retries immediately.
 *
 * Error codes on thrown errors:
 *   - 'PREFLIGHT'   : rejected before landing (no funds moved) — safe to retry/refund
 *   - 'ONCHAIN_FAIL': landed but failed (no funds moved)        — safe to retry/refund
 *   - 'UNCONFIRMED' : submitted, outcome unknown (may have paid) — do NOT retry/refund
 */

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Local base58 so we can know a transaction's signature before it is broadcast,
// without adding a dependency.
function base58Encode(bytes) {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let k = 0; k < bytes.length - 1 && bytes[k] === 0; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58_ALPHABET[digits[q]];
  return out;
}

// Errors that prove the transaction never reached the cluster. Anything else that
// goes wrong during submit is ambiguous and must be resolved against the chain.
function provesNotSubmitted(message) {
  return /Blockhash not found|blockhash not found|Node is behind|429|Too Many Requests|rate limit/i.test(message);
}
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

    // The signature is fixed the moment the transaction is signed. Knowing it up
    // front is what lets us resolve an ambiguous submit against the chain instead
    // of blindly rebuilding (which is how the same spin could pay twice).
    const signature = base58Encode(tx.signatures[0]);

    // --- Submit ---
    try {
      await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false, // surface simulation errors before anything is submitted
        maxRetries: 2,
        preflightCommitment: commitment,
      });
    } catch (e) {
      lastErr = e;
      const m = String(e?.message || e);

      // Proven not submitted → safe to rebuild with a fresh blockhash right away.
      if (provesNotSubmitted(m)) continue;

      // A simulation rejection also means nothing moved. Identify it positively:
      // preflight failures carry simulation logs / an explicit "Transaction simulation failed".
      const isSimulationFailure =
        Array.isArray(e?.logs) ||
        /Transaction simulation failed|insufficient funds|custom program error|InstructionError|invalid account/i.test(m);
      if (isSimulationFailure) {
        const err = new Error(`Transfer rejected at preflight: ${m}`);
        err.code = 'PREFLIGHT';
        throw err;
      }

      // Anything else (timeout, socket hang up, fetch failed) is AMBIGUOUS: the
      // request may have been delivered. Fall through and let the chain decide.
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
