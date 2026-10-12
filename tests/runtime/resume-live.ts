import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, transferChecked } from '@solana/spl-token';
import { loadExternalKeypair } from '../../packages/agent-runtime/src/signing.ts';

// Explicit real localnet check. This is not included in unit tests and does not
// reset the validator, change devnet, or modify the original demo manifest.
const manifestPath = 'artifacts/recovery-demo-localnet.json';
const evidencePath = 'artifacts/recovery-demo-localnet-evidence.json';
const originalManifest = await readFile('artifacts/demo.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.network, 'localnet'); assert.equal(manifest.rpcUrl, 'http://127.0.0.1:8899');
const connection = new Connection(manifest.rpcUrl, 'confirmed');
const keyDirectory = process.env.AGENTBOND_KEY_DIR ?? join(homedir(), '.agentbond', 'keys');
const creator = await loadExternalKeypair(join(keyDirectory, 'creator.json'));
const worker = await loadExternalKeypair(join(keyDirectory, 'worker.json'));
const mint = new PublicKey(manifest.mint);
const creatorToken = await getAssociatedTokenAddress(mint, creator.publicKey), workerToken = await getAssociatedTokenAddress(mint, worker.publicKey);
const before = (await getAccount(connection, workerToken)).amount;
const originalSnapshots = manifest.jobs.map((job: any) => structuredClone(job.balanceEvidence));
const additionalPayment = await transferChecked(connection, creator, creatorToken, mint, workerToken, creator, 1n, manifest.decimals);
const after = (await getAccount(connection, workerToken)).amount; assert.equal(after-before, 1n);
for (const job of manifest.jobs) { job.transactions = []; delete job.receiptPath; delete job.artifactPath; delete job.balanceEvidence; }
manifest.checks = {}; await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts'], { stdio: 'inherit', env: { ...process.env, AGENTBOND_DEMO_MANIFEST: manifestPath, AGENTBOND_DEMO_EVIDENCE: evidencePath } });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Resume demo exited ${code}`)));
});
const recovered = JSON.parse(await readFile(manifestPath, 'utf8'));
for (let i = 0; i < recovered.jobs.length; i++) {
  const job = recovered.jobs[i]; assert.deepEqual(job.balanceEvidence, originalSnapshots[i]);
  assert.equal(job.transactions.length, 6); assert(job.transactions.every((tx: any) => tx.signature && ['confirmed','finalized'].includes(tx.finality)));
  assert(job.receiptPath && job.artifactPath);
}
assert.equal((await getAccount(connection, workerToken)).amount, after, 'Resume must not repeat a settlement');
assert.deepEqual(await readFile('artifacts/demo.json'), originalManifest, 'Original deployment manifest must not be replaced by recovery test');
const evidence = { network: 'localnet', verifiedAt: new Date().toISOString(), manifest: manifestPath, additionalPayment, additionalBaseUnits: '1', workerBefore: before.toString(), workerAfter: after.toString(), lostManifestFields: ['transactions','receiptPath','artifactPath','balanceEvidence'], exactHistoricalTransactionBalancesRecovered: true, originalManifestUnchanged: true, noRepeatSettlement: true, jobs: recovered.jobs.map((job: any) => ({ address: job.address, status: job.status, balanceEvidence: job.balanceEvidence, signatures: job.transactions.map((tx: any) => tx.signature) })) };
await writeFile('artifacts/recovery-resume-check.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
