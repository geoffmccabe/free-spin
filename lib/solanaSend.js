// /lib/solanaSend.js
import {
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';

/**
 * Sends a transaction using a fresh blockhash with small retries.
 * - Adds ComputeBudget and priority fee.
 * - Surfaces original error for the caller to classify.
 */
export async function sendTxWithFreshBlockhash({
  connection,
  payer,               // Keypair
  instructions,        // array of ixs
  recentAccounts = [], // extra addresses to "warm up" via getMultipleAccounts
  maxRetries = 3,
  commitment = 'confirmed',
}) {
  // Soft warm-up of accounts to reduce "could not find account" errors under load
  try {
    const addrs = []
      .concat(recentAccounts)
      .map((a) => (typeof a === 'string' ? a : a.toBase58?.() || String(a)))
      .filter(Boolean);
    if (addrs.length) {
      const unique = [...new Set(addrs)];
      // harmless call
      await connection.getMultipleAccountsInfo(unique.map((a) => ({ toBase58: () => a })));
    }
  } catch {}

  const cuPrices = [2000, 5000, 25000]; // micro-lamports per CU (progressively higher)
  const cuLimits = [200000, 400000, 600000];

  let lastErr;

  for (let i = 0; i < Math.max(1, maxRetries); i++) {
    try {
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

      const sig = await connection.sendTransaction(tx, {
        skipPreflight: false, // we want simulation errors back
        maxRetries: 2,
        preflightCommitment: commitment,
      });

      // Optionally confirm
      const conf = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        commitment
      );
      if (conf?.value?.err) {
        throw new Error(`Transaction not confirmed: ${JSON.stringify(conf.value.err)}`);
      }
      return sig;
    } catch (e) {
      lastErr = e;
      // If it's a "Blockhash not found" or "priority fee too low", retry with higher fee
      const msg = String(e?.message || e);
      const transient =
        msg.includes('Blockhash not found') ||
        msg.includes('block height exceeded') ||
        msg.includes('TransactionExpiredBlockheightExceeded') ||
        msg.includes('Priority') ||
        msg.includes('temporary') ||
        msg.includes('Node is behind') ||
        msg.includes('Preflight') ||
        msg.includes('429') ||
        msg.includes('Too Many Requests');

      if (!transient && i >= 0) {
        // Non-transient → break immediately, let caller classify.
        break;
      }
      // else retry next loop with higher fee settings
    }
  }

  throw lastErr || new Error('sendTx failed');
}
