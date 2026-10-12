import { readFile, writeFile, link, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connection, Transaction, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '../../shared/src/index.ts';

export interface PendingTransaction { version: 1; identity: string; signature: string; raw: string; messageHash: string; blockhash: string; lastValidBlockHeight: number; createdAt: string }
export interface JournalResult { state: 'CONFIRMED'|'EXPIRED'; signature: string; recovered: boolean; finality?: 'confirmed'|'finalized' }
async function persist(path: string, value: PendingTransaction) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true });
  let installed=false;
  try { await link(tmp,path); installed=true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
  finally { await unlink(tmp); }
  // Install exclusively, then persist its directory entry before any broadcast.
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return installed;
}
async function load(path: string, identity: string): Promise<PendingTransaction | null> {
  let text: string; try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (text.length > 20000) throw new Error('Invalid transaction journal size');
  const value = JSON.parse(text) as PendingTransaction;
  if (value.version !== 1 || value.identity !== identity || typeof value.identity !== 'string' || value.identity.length > 2048 || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 0) throw new Error('Transaction journal identity or validity mismatch');
  if (typeof value.raw !== 'string' || value.raw.length > 4000 || typeof value.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value.signature) || typeof value.messageHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.messageHash) || typeof value.blockhash !== 'string' || value.blockhash.length > 44) throw new Error('Transaction journal fields malformed');
  const transaction = Transaction.from(Buffer.from(value.raw, 'base64'));
  if (!transaction.signature || bs58.encode(transaction.signature) !== value.signature || transaction.recentBlockhash !== value.blockhash || sha256(transaction.serializeMessage()) !== value.messageHash || !transaction.verifySignatures()) throw new Error('Transaction journal signature or message mismatch');
  return value;
}
export async function resumeDurableTransaction(connection: Pick<Connection,'getSignatureStatuses'|'getBlockHeight'|'sendRawTransaction'|'isBlockhashValid'>, path: string, identity: string, options: { polls?: number; intervalMs?: number } = {}): Promise<JournalResult | null> {
  const journal = await load(path, identity); if (!journal) return null;
  let rebroadcast = false;
  for (let attempt = 0; attempt < (options.polls ?? 12); attempt++) {
    const status = (await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`Journaled transaction ${journal.signature} failed onchain; preserve its journal for inspection`);
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return { state: 'CONFIRMED', signature: journal.signature, recovered: true, finality: status.confirmationStatus };
    if (!status && await connection.getBlockHeight('finalized') > journal.lastValidBlockHeight && !(await connection.isBlockhashValid(journal.blockhash, { commitment: 'finalized' })).value) return { state: 'EXPIRED', signature: journal.signature, recovered: true };
    if (!rebroadcast && !status) {
      rebroadcast = true;
      try {
        const signature = await connection.sendRawTransaction(Buffer.from(journal.raw, 'base64'), { skipPreflight: false, maxRetries: 0 });
        if (signature !== journal.signature) throw new Error('RPC returned an unexpected transaction signature');
      } catch { /* Ambiguous transport response: query the same signature, never sign another transfer. */ }
    }
    if (attempt + 1 < (options.polls ?? 12)) await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 500));
  }
  throw new Error(`Transaction ${journal.signature} remains pending; resume the same journal without repeating its financial effect`);
}
export async function sendDurableTransaction(connection: Pick<Connection,'getSignatureStatuses'|'getBlockHeight'|'sendRawTransaction'|'getLatestBlockhash'|'isBlockhashValid'>, transaction: Transaction, signer: Keypair | Keypair[], path: string, identity: string, options: { polls?: number; intervalMs?: number } = {}): Promise<JournalResult> {
  const existing = await resumeDurableTransaction(connection, path, identity, options);
  if (existing) return existing;
  const latest = await connection.getLatestBlockhash('confirmed');
  const signers = Array.isArray(signer) ? signer : [signer]; if (!signers.length) throw new Error('Transaction signer required');
  transaction.feePayer = signers[0].publicKey; transaction.recentBlockhash = latest.blockhash; transaction.sign(...signers);
  if (!transaction.signature) throw new Error('Signed transaction has no signature');
  const journal: PendingTransaction = { version: 1, identity, signature: bs58.encode(transaction.signature), raw: transaction.serialize().toString('base64'), messageHash: sha256(transaction.serializeMessage()), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, createdAt: new Date().toISOString() };
  const installed = await persist(path, journal); // Another caller's installed signature always wins.
  const result = await resumeDurableTransaction(connection, path, identity, options);
  if (!result) throw new Error('Transaction journal disappeared');
  return { ...result, recovered: !installed };
}
