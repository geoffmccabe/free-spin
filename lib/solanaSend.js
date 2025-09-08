// lib/solanaSend.js
import {
  Transaction,
  SystemProgram,
} from '@solana/web3.js';

/**
 * Send a transaction with a fresh blockhash and confirm it with strict timeouts & retries.
 *
 * Always resolves with a signature OR throws a clear, finite error.
 * It can no longer hang indefinitely.
 */
export async function sendTxWithFreshBlockhash({
  connection,
  payer,                 // Keypair
  instructions = [],     // array of web3.js Instructions
  maxRetries = 3,        // number of send/confirm attempts with new blockhash
  commitment = 'confirmed',
  perAttemptConfirmTimeoutMs = 10000, // timeout for each confirm phase
  overallTimeoutMs = 25000,           // global cap across all attempts
}) {
  const startOverall = Date.now();

  const withTimeout = (p, ms, label) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label || 'timeout'} after ${ms}ms`)), ms)
      ),
    ]);

  let lastErr;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const elapsed = Date.now() - startOverall;
    if (elapsed >= overallTimeoutMs) {
      throw new Error(`[E] overall-timeout: exceeded ${overallTimeoutMs}ms`);
    }

    try {
      // [T0] Fetch fresh blockhash
      const bhStart = Date.now();
      const { blockhash, lastValidBlockHeight } = await withTimeout(
        connection.getLatestBlockhash({ commitment }),
        Math.max(3000, perAttemptConfirmTimeoutMs / 2),
        'blockhash-fetch-timeout'
      );
      console.log(`[T0] blockhash fetched (attempt ${attempt}) in ${Date.now() - bhStart}ms`);

      // Build and sign legacy Transaction
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
      for (const ix of instructions) tx.add(ix);
      tx.sign(payer);

      // [T1] Send raw
      const sendStart = Date.now();
      const signature = await withTimeout(
        connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 }),
        Math.max(5000, perAttemptConfirmTimeoutMs / 2),
        'send-timeout'
      );
      console.log(`[T1] sent (attempt ${attempt}) sig=${signature} in ${Date.now() - sendStart}ms`);

      // [T2] Confirm by polling with a per-attempt timeout
      const confirmStart = Date.now();
      const confirmedSig = await withTimeout(
        confirmSignatureWithPolling({
          connection,
          signature,
          lastValidBlockHeight,
          targetCommitment: commitment,
          pollIntervalMs: 500,
        }),
        perAttemptConfirmTimeoutMs,
        'confirm-timeout'
      );
      console.log(`[T3] confirmed (attempt ${attempt}) sig=${confirmedSig} in ${Date.now() - confirmStart}ms`);

      return signature;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);

      // If blockhash expired or we hit a transient, retry with a new blockhash
      const shouldRetry =
        msg.includes('blockhash not found') ||
        msg.includes('expired blockhash') ||
        msg.includes('Transaction expired') ||
        msg.includes('Node is behind') ||
        msg.includes('send-timeout') ||
        msg.includes('confirm-timeout') ||
        msg.includes('blockhash-fetch-timeout');

      console.error(`[E] attempt ${attempt} failed: ${msg}`);

      const elapsed = Date.now() - startOverall;
      if (!shouldRetry || attempt >= maxRetries || elapsed >= overallTimeoutMs) {
        throw new Error(`[E] send/confirm failed after ${attempt} attempts (${elapsed}ms): ${msg}`);
      }

      // brief backoff before retrying
      await sleep(300 + Math.floor(Math.random() * 400));
      continue;
    }
  }

  throw lastErr || new Error('[E] unknown failure in sendTxWithFreshBlockhash');
}

async function confirmSignatureWithPolling({
  connection,
  signature,
  lastValidBlockHeight,
  targetCommitment = 'confirmed',
  pollIntervalMs = 500,
}) {
  // Poll getSignatureStatuses until:
  //  - confirmation at the desired level, or
  //  - error status, or
  //  - lastValidBlockHeight is exceeded (treat as expired)
  while (true) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = value[0];

    if (status) {
      if (status.err) {
        throw new Error(`transaction error: ${JSON.stringify(status.err)}`);
      }
      // If we have a confirmationStatus, honor it.
      const cs = status.confirmationStatus;
      if (cs === 'finalized' || (cs === 'confirmed' && (targetCommitment === 'processed' || targetCommitment === 'confirmed'))) {
        return signature;
      }
      if (cs === 'processed' && targetCommitment === 'processed') {
        return signature;
      }
    }

    // Check block height expiry
    const current = await connection.getBlockHeight();
    if (current > lastValidBlockHeight) {
      throw new Error('expired blockhash (last valid block height passed)');
    }

    await sleep(pollIntervalMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default sendTxWithFreshBlockhash;
