import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { Connection, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { ensureKeys } from './keys.ts';
import { join } from 'node:path';
import { loadExternalKeypair, resumeDurableTransaction, sendDurableTransaction } from '../packages/agent-runtime/src/index.ts';
import { inspectDeployment } from './deploy.ts';
import { PROGRAM_ID } from '../packages/sdk/src/index.ts';

const dir = await ensureKeys();
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
if (await connection.getGenesisHash() !== genesis) throw new Error('Expected devnet; no funding effect attempted');
const actors = await Promise.all(['creator', 'worker', 'verifier', 'deployer'].map(name => loadExternalKeypair(join(dir, name + '.json'))));
const deployer = actors[3];
await mkdir('.orchestrator', { recursive: true });
const evidencePath = '.orchestrator/funding-check.json';
type Entry = { action: string; address?: string; signature: string; finality?: string; state?: string };
const evidence: { time: string; network: string; genesis: string; wallets: { address: string; lamports: number }[]; transactions: Entry[]; error?: string; status?: string; deployerLamports?: number; deploymentReconciled?: boolean; deploymentReserveLamports?: number } = { time: new Date().toISOString(), network: 'devnet', genesis, wallets: [], transactions: [] };
try {
  const previous = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (previous.network === 'devnet' && Array.isArray(previous.transactions)) evidence.transactions = previous.transactions;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const checkpoint = async () => {
  evidence.wallets = await Promise.all(actors.map(async actor => ({ address: actor.publicKey.toBase58(), lamports: await connection.getBalance(actor.publicKey, 'confirmed') })));
  const temporary = evidencePath + '.tmp'; await writeFile(temporary, JSON.stringify(evidence, null, 2)); await rename(temporary, evidencePath);
};
const record = (entry: Entry) => { if (!evidence.transactions.some(value => value.signature === entry.signature)) evidence.transactions.push(entry); };

// One explicit faucet request per invocation, with its returned signature persisted
// before waiting. This is not a retry loop against a shared rate-limited faucet.
if (process.argv.includes('--request-airdrop') && await connection.getBalance(deployer.publicKey) < 5 * LAMPORTS_PER_SOL) {
  try {
    const signature = await connection.requestAirdrop(deployer.publicKey, 5 * LAMPORTS_PER_SOL);
    record({ action: 'airdrop', signature, state: 'PENDING' }); await checkpoint();
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) throw new Error('Airdrop failed onchain');
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!status || status.err || !['confirmed', 'finalized'].includes(status.confirmationStatus ?? '')) throw new Error('Airdrop confirmation remains uncertain');
    const entry = evidence.transactions.find(value => value.signature === signature)!; entry.finality = status.confirmationStatus!; entry.state = 'CONFIRMED'; await checkpoint();
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); await checkpoint(); }
}
const target = 30_000_000;
let deploymentReserve = 5 * LAMPORTS_PER_SOL;
try {
  const binary = await readFile('target/deploy/agentbond.so');
  const existing = await inspectDeployment(connection, PROGRAM_ID, binary, deployer.publicKey);
  evidence.deploymentReconciled = !!existing?.binaryMatches;
  deploymentReserve = existing?.binaryMatches ? 1_000_000 : 2 * await connection.getMinimumBalanceForRentExemption(binary.length + 45) + 150_000_000;
}
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
evidence.deploymentReserveLamports = deploymentReserve;
for (const actor of actors.slice(0, 3)) {
  const address = actor.publicKey.toBase58();
  const journalPath = join(dir, `funding-devnet-${address}.pending.json`);
  const identity = `${genesis}:${deployer.publicKey.toBase58()}:${address}:target=${target}`;
  // Reconcile an older signed transfer before looking at a stale recipient balance.
  const pending = await resumeDurableTransaction(connection, journalPath, identity);
  if (pending) {
    record({ action: pending.state === 'CONFIRMED' ? 'fund-role' : 'fund-role-expired', address, signature: pending.signature, state: pending.state, finality: pending.finality });
    await checkpoint(); await unlink(journalPath);
  }
  const balance = await connection.getBalance(actor.publicKey, 'confirmed');
  if (balance >= target) continue;
  const available = await connection.getBalance(deployer.publicKey, 'confirmed');
  if (available < deploymentReserve + (target - balance) + 100_000) {
    evidence.status = 'BLOCKED'; evidence.deployerLamports = available; await checkpoint();
    throw new Error(`Deployer has ${available} lamports; funding is insufficient for a safe devnet deploy. See docs/FUNDING.md.`);
  }
  const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: actor.publicKey, lamports: target - balance }));
  const sent = await sendDurableTransaction(connection, transaction, deployer, journalPath, identity);
  if (sent.state !== 'CONFIRMED') { record({ action: 'fund-role-expired', address, signature: sent.signature, state: sent.state }); await checkpoint(); await unlink(journalPath); throw new Error('Signed role transfer expired without landing; rerun to recompute current balance'); }
  record({ action: 'fund-role', address, signature: sent.signature, state: sent.state, finality: sent.finality });
  await checkpoint();
  if (await connection.getBalance(actor.publicKey, 'confirmed') < target) throw new Error('Confirmed role funding did not reach the target balance');
  await unlink(journalPath); // Delete only after evidence and actual balance are saved.
}
evidence.deployerLamports = await connection.getBalance(deployer.publicKey, 'confirmed');
if (evidence.deployerLamports < deploymentReserve) { evidence.status = 'BLOCKED'; await checkpoint(); throw new Error('Role wallets reconciled, but deployer still needs test SOL for program and buffer rent'); }
evidence.status = 'COMPLETE'; await checkpoint();
console.log('Generated devnet role wallets and transaction signatures independently confirmed');
