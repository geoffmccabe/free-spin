// /lib/solanaSend.js
import {
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';

export async function sendTxWithFreshBlockhash({
  connection,
  payer,
  instructions,
  recentAccounts = [],
  maxRetries = 3,
  commitment = 'confirmed',
  cuLimit = 250_000,
  cuPriceMicrolamports = 2_000,
}) {
  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicrolamports }),
  ];
  const ixs = [...computeIxs, ...instructions];

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);

    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const vtx = new VersionedTransaction(msg);
    vtx.sign([payer, ...recentAccounts]);

    try {
      const signature = await connection.sendTransaction(vtx, {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: commitment,
      });
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment);
      return signature;
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const expired = msg.includes('block height exceeded') || msg.includes('expired') || msg.includes('BlockhashNotFound');
      const transient = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('429');

      if ((expired || transient) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error('sendTxWithFreshBlockhash failed');
}
