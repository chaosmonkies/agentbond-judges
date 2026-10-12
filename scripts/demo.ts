import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename, chmod, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { createMint, getMint, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, getAccount, createMintToInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AgentBondClient, PROGRAM_ID } from '../packages/sdk/src/index.ts';
import { jobSpecSchema, sha256, specificationHashes, type AgentProfile } from '../packages/shared/src/index.ts';
import { discoverEligibleJobs, runWorkerJob, verifyAndRecordJob, recoverJobTransactions, tokenBalanceSnapshot, isExpectedAnchorError, resumeDurableTransaction, sendDurableTransaction } from '../packages/agent-runtime/src/index.ts';
import { readBoundedArtifact } from '../apps/api/src/artifacts.ts';
import { CSV, INPUT_ORIGIN, inputServer } from './inputs.ts';
import { ensureKeys } from './keys.ts';

const network = process.argv.includes('--devnet') ? 'devnet' : 'localnet';
const rpcUrl = network === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899';
const connection = new Connection(rpcUrl, 'confirmed');
const keys = await ensureKeys();
const load = async (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(keys, name + '.json'), 'utf8'))));
const [creator, worker, verifier, deployer] = await Promise.all(['creator','worker','verifier','deployer'].map(load));
const genesis = await connection.getGenesisHash();
if (network === 'devnet') assert.equal(genesis, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'RPC must be devnet');
assert((await connection.getAccountInfo(PROGRAM_ID))?.executable, 'Deploy the built program before running the demo');
for (const actor of [creator, worker, verifier, deployer]) {
  if (await connection.getBalance(actor.publicKey) < 0.02 * LAMPORTS_PER_SOL) {
    if (network === 'devnet') throw new Error(`Devnet wallet ${actor.publicKey} needs 0.02 SOL; run scripts/funding.ts`);
    const signature = await connection.requestAirdrop(actor.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, 'confirmed');
  }
}
const client = (signer: Keypair) => new AgentBondClient(connection, new anchor.Wallet(signer));
const creatorClient = client(creator), workerClient = client(worker), verifierClient = client(verifier);
await mkdir('artifacts', { recursive: true });
const manifestPath = process.env.AGENTBOND_DEMO_MANIFEST ?? `artifacts/demo-${network}.json`;
type TransactionEvidence = { action: string; signature: string; finality: string; explorer: string; slot?: number; confirmationSource?: string };
type DemoJob = { address: string; id: string; title: string; spec: ReturnType<typeof jobSpecSchema.parse>; transactions: TransactionEvidence[]; artifactPath?: string; receiptPath?: string; balanceEvidence?: Record<string, string>; status?: string };
type Manifest = { network: string; rpcUrl: string; programId: string; mint: string; decimals: number; tokenName: string; jobs: DemoJob[]; agents: AgentProfile[]; createdAt: string; verifiedAt?: string; mintAuthority: string; inputHash: string; checks: Record<string, boolean>; tokenTransactions?: { action: string; signature: string; finality?: string; state: string }[] };
let manifest: Manifest;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; manifest = { network, rpcUrl, programId: PROGRAM_ID.toBase58(), mint: '', decimals: 6, tokenName: 'AgentBond Demo USD', jobs: [], agents: [], createdAt: new Date().toISOString(), mintAuthority: creator.publicKey.toBase58(), inputHash: sha256(CSV), checks: {} }; }
assert.equal(manifest.programId, PROGRAM_ID.toBase58());
assert.equal(manifest.network, network); assert.equal(manifest.rpcUrl, rpcUrl); assert.equal(manifest.mintAuthority, creator.publicKey.toBase58());
assert.equal(manifest.inputHash, sha256(CSV));
const lockPath = manifestPath + '.lock', lockToken = randomUUID();
try { const handle = await open(lockPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token: lockToken })); await handle.close(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
  let alive = true; try { process.kill(owner.pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
  if (alive) throw new Error(`Another demo process owns ${lockPath}; refusing concurrent financial effects`);
  await unlink(lockPath); const handle = await open(lockPath, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token: lockToken })); await handle.close();
}
const checkpoint = async () => {
  const temp = manifestPath + '.tmp'; await writeFile(temp, JSON.stringify(manifest, null, 2)); await rename(temp, manifestPath);
  if (!process.env.AGENTBOND_DEMO_MANIFEST) { await writeFile('artifacts/demo.json.tmp', JSON.stringify(manifest, null, 2)); await rename('artifacts/demo.json.tmp', 'artifacts/demo.json'); }
};
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=${network === 'devnet' ? 'devnet' : 'custom&customUrl=' + encodeURIComponent(rpcUrl)}`;
const recover = async (job: DemoJob) => {
  const entries = await recoverJobTransactions(connection, creatorClient, job.address, explorer, job.title.startsWith('Reject'));
  // Current transaction history is authoritative when available. Keep earlier
  // checkpoints explicitly historical if a local validator has pruned them.
  const previous = new Map(job.transactions.map(tx => [tx.signature, { ...tx, confirmationSource: 'previously verified checkpoint' }]));
  for (const entry of entries) previous.set(entry.signature, { ...entry, confirmationSource: 'current RPC transaction history' });
  job.transactions = [...previous.values()].sort((a,b) => (a.slot ?? 0) - (b.slot ?? 0)); await checkpoint();
};
const record = async (job: DemoJob, action: string, signature: string | undefined) => {
  if (signature) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    assert(status && !status.err && ['confirmed','finalized'].includes(status.confirmationStatus ?? ''), `Transaction ${action} must independently confirm`);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await recover(job);
    if (!signature || job.transactions.some(tx => tx.signature === signature && tx.action === action)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (signature) assert(job.transactions.some(tx => tx.signature === signature && tx.action === action), `Transaction ${action} must decode to the actual expected program instruction`);
};
const restoreReceipt = async (job: DemoJob) => {
  const chain = await creatorClient.getJob(job.address); assert(chain);
  if (!/^0+$/.test(chain.verificationHash)) {
    const path = job.receiptPath ?? `artifacts/analysis/${job.address}.receipt.json`;
    const bytes = await readBoundedArtifact(path, 'artifacts'); assert.equal(sha256(bytes), chain.verificationHash, 'Receipt bytes must match the actual chain commitment');
    const receipt = JSON.parse(bytes.toString()); assert.equal(receipt.jobAddress, job.address); assert.equal(receipt.artifactHash, chain.artifactHash);
    job.receiptPath = path;
  }
  if (!/^0+$/.test(chain.artifactHash)) {
    const path = job.artifactPath ?? `artifacts/analysis/${job.address}.artifact.json`;
    assert.equal(sha256(await readBoundedArtifact(path, 'artifacts')), chain.artifactHash, 'Artifact bytes must match chain'); job.artifactPath = path;
  }
  await checkpoint();
};
const balanceEvidence = async (job: DemoJob, action: 'settle'|'refund', recipient: PublicKey, vault: PublicKey) => {
  await recover(job); const tx = job.transactions.find(value => value.action === action); assert(tx, `Missing actual ${action} signature`);
  const transaction = await connection.getTransaction(tx.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!transaction) {
    const prior = job.balanceEvidence; const before = action === 'settle' ? prior?.workerBefore : prior?.creatorBefore, after = action === 'settle' ? prior?.workerAfter : prior?.creatorAfter;
    assert(before && after && prior?.vaultBefore && prior.vaultAfter, 'RPC history unavailable and no prior exact balance checkpoint exists');
    assert.equal(BigInt(after)-BigInt(before), 25_000_000n); assert.equal(BigInt(prior.vaultBefore)-BigInt(prior.vaultAfter), 25_000_000n); assert.equal(prior.vaultAfter, '0');
    console.log(`Historical balance checkpoint retained for ${job.address}; RPC no longer retains its transaction metadata`);
    return { ...prior, source: 'previously verified checkpoint; RPC history unavailable', signature: tx.signature };
  }
  const snapshot = tokenBalanceSnapshot(transaction, { recipient: recipient.toBase58(), vault: vault.toBase58() }, manifest.mint);
  assert.equal(BigInt(snapshot.recipientAfter)-BigInt(snapshot.recipientBefore), 25_000_000n);
  assert.equal(BigInt(snapshot.vaultBefore)-BigInt(snapshot.vaultAfter), 25_000_000n);
  assert.equal(snapshot.vaultAfter, '0');
  const result: Record<string,string> = { vaultBefore: snapshot.vaultBefore, vaultAfter: snapshot.vaultAfter, source: 'confirmed transaction token balances', signature: tx.signature };
  if (action === 'settle') { result.workerBefore = snapshot.recipientBefore; result.workerAfter = snapshot.recipientAfter; }
  else { result.creatorBefore = snapshot.recipientBefore; result.creatorAfter = snapshot.recipientAfter; }
  return result;
};
const rejectDuplicate = async (job: DemoJob, recipient: PublicKey, operation: 'settle'|'refund') => {
  const before = await creatorClient.getJob(job.address), recipientBefore = (await getAccount(connection, recipient)).amount, vault = creatorClient.vaultAddress(job.address), vaultBefore = (await getAccount(connection, vault)).amount;
  let rejected = false;
  try { if (operation === 'settle') await workerClient.settleJob(job.address, recipient); else await creatorClient.refundJob(job.address, recipient); }
  catch (error) { assert(isExpectedAnchorError(error, operation === 'settle' ? 'InvalidState' : 'RefundUnavailable'), 'RPC failure is not proof of program duplicate-transfer rejection'); rejected = true; }
  assert(rejected, 'Duplicate transfer unexpectedly succeeded');
  assert.deepEqual(await creatorClient.getJob(job.address), before, 'Terminal chain account must not mutate');
  assert.equal((await getAccount(connection, recipient)).amount, recipientBefore); assert.equal((await getAccount(connection, vault)).amount, vaultBefore);
};
let input = await fetch(INPUT_ORIGIN + '/health').then(r => r.ok).catch(() => false) ? null : await inputServer();
try {
  const mintFile = join(keys, `mint-${network}.json`);
  let mintPair: Keypair;
  try { mintPair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(mintFile, 'utf8')))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid persisted mint key; refusing a replacement mint'); mintPair = Keypair.generate(); await writeFile(mintFile, JSON.stringify(Array.from(mintPair.secretKey)), { mode: 0o600, flag: 'wx' }); await chmod(mintFile, 0o600); }
  if (!(await connection.getAccountInfo(mintPair.publicKey))) {
    await createMint(connection, creator, creator.publicKey, null, 6, mintPair, { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
  }
  if (manifest.mint) assert.equal(manifest.mint, mintPair.publicKey.toBase58(), 'Persisted mint must not change on resume');
  const mintData = await getMint(connection, mintPair.publicKey); assert.equal(mintData.decimals, 6); assert.equal(mintData.freezeAuthority, null); assert(mintData.mintAuthority?.equals(creator.publicKey));
  manifest.mint = mintPair.publicKey.toBase58(); await checkpoint();
  const mint = mintPair.publicKey;
  const creatorAta = await getOrCreateAssociatedTokenAccount(connection, creator, mint, creator.publicKey);
  const workerAta = await getOrCreateAssociatedTokenAccount(connection, creator, mint, worker.publicKey);
  const mintJournal = join(keys, `demo-${network}-${mint.toBase58()}.mint.pending.json`), mintIdentity = `${genesis}:mint:${mint.toBase58()}:${creatorAta.address.toBase58()}:topup=1000000000`;
  const saveMint = async (result: { signature: string; state: string; finality?: string }) => {
    manifest.tokenTransactions ??= [];
    if (!manifest.tokenTransactions.some(value => value.signature === result.signature)) manifest.tokenTransactions.push({ action: 'mint-demo-test-tokens', ...result });
    await checkpoint(); await unlink(mintJournal);
  };
  const pendingMint = await resumeDurableTransaction(connection, mintJournal, mintIdentity);
  if (pendingMint) await saveMint(pendingMint);
  if ((await getAccount(connection, creatorAta.address)).amount < 100_000_000n) {
    const result = await sendDurableTransaction(connection, new Transaction().add(createMintToInstruction(mint, creatorAta.address, creator.publicKey, 1_000_000_000n)), creator, mintJournal, mintIdentity);
    await saveMint(result); assert.equal(result.state, 'CONFIRMED', 'Test-token mint expired; rerun with reconciled balance');
    assert((await getAccount(connection, creatorAta.address)).amount >= 100_000_000n, 'Confirmed mint must produce actual test token balance');
  }
  manifest.agents = [
    { id: 'csv-worker', wallet: worker.publicKey.toBase58(), capabilities: ['bounded-csv-statistics','threshold-anomalies'], taskTypes: ['csv-analysis'], maxRuntimeMs: 2000, metadata: { name: 'Atlas · CSV worker', runtime: 'Node permission sandbox' } },
    { id: 'independent-verifier', wallet: verifier.publicKey.toBase58(), capabilities: ['independent-recomputation','sha256-integrity','schema-validation'], taskTypes: ['csv-analysis'], maxRuntimeMs: 2000, metadata: { name: 'Sentinel · designated verifier', trust: 'MVP trusted verifier' } },
  ];
  const spec = jobSpecSchema.parse({ type: 'csv-analysis', input: { url: INPUT_ORIGIN + '/inputs/demo.csv', hash: sha256(CSV) }, acceptance: { numericColumns: ['revenue','orders'], anomaly: { column: 'revenue', threshold: 1000, direction: 'above' } } });
  const hashes = specificationHashes(spec);
  const ensureJob = async (title: string, offset: number) => {
    let job = manifest.jobs.find(j => j.title === title);
    if (!job) {
      const id = (BigInt(Date.now()) * 10n + BigInt(offset)).toString();
      job = { title, id, address: creatorClient.jobAddress(creator.publicKey, id).toBase58(), spec, transactions: [] };
      manifest.jobs.push(job); await checkpoint();
    }
    if (!(await creatorClient.getJob(job.address))) {
      const now = Math.floor(Date.now()/1000);
      const created = await creatorClient.createJob({ id: job.id, mint, amount: 25_000_000n, verifier: verifier.publicKey, ...specificationHashes(job.spec), claimDeadline: now+3600, submitDeadline: now+7200, verifyDeadline: now+10800 });
      await record(job, 'create', created.signature);
    }
    const chain = await creatorClient.getJob(job.address);
    assert(chain); assert.equal(chain.creator, creator.publicKey.toBase58()); assert.equal(chain.mint, mint.toBase58()); assert.equal(chain.verifier, verifier.publicKey.toBase58()); assert.equal(chain.amount, '25000000');
    assert.equal(chain.specHash, specificationHashes(job.spec).specHash); assert.equal(chain.acceptanceHash, specificationHashes(job.spec).acceptanceHash);
    if (chain?.status === 'CREATED') await record(job, 'fund', await creatorClient.fundJob(job.address, creatorAta.address));
    await recover(job);
    return job;
  };
  const success = await ensureJob('Analyze weekly revenue and detect anomalies', 1);
  const vault = creatorClient.vaultAddress(success.address);
  let chain = await creatorClient.getJob(success.address);
  if (chain?.status !== 'SETTLED') {
    if (!success.balanceEvidence) { success.balanceEvidence = { workerBefore: (await getAccount(connection, workerAta.address)).amount.toString(), vaultBefore: (await getAccount(connection, vault)).amount.toString() }; await checkpoint(); }
    const eligible = await discoverEligibleJobs(workerClient, async address => manifest.jobs.find(j => j.address === address)?.spec ?? null, [INPUT_ORIGIN]);
    assert(eligible.some(j => j.job.address === success.address) || chain?.worker === worker.publicKey.toBase58(), 'Worker must discover a funded job or reconcile its own claim');
    console.log('Worker discovered eligible chain jobs:', eligible.map(j => j.job.address));
    const trace = async (event: unknown) => { console.log(JSON.stringify(event)); const { appendFile } = await import('node:fs/promises'); await appendFile('artifacts/traces.jsonl', JSON.stringify(event)+'\n'); };
    const outputDir = 'artifacts/analysis';
    const result = await runWorkerJob({ client: workerClient, jobAddress: success.address, workerAddress: worker.publicKey.toBase58(), spec: success.spec, outputDir, inputPolicy: { allowedOrigins: [INPUT_ORIGIN], allowLoopback: true }, trace });
    success.artifactPath = result.artifactPath;
    await record(success, 'claim', result.claimSignature); await record(success, 'submit', result.submitSignature);
    chain = await creatorClient.getJob(success.address);
    if (chain?.status === 'SUBMITTED') {
      const beforeUnauthorized = chain;
      let unauthorizedRejected = false;
      try { await workerClient.approveWork(success.address, sha256('unauthorized-verifier-attempt')); }
      catch (error) {
        const failure = error as { error?: { errorCode?: { code?: string; number?: number } }; logs?: string[] };
        assert((failure.error?.errorCode?.code === 'ConstraintHasOne' && failure.error.errorCode.number === 2001) || failure.logs?.some(log => log.includes('Error Code: ConstraintHasOne. Error Number: 2001.')), 'RPC failure is not proof of verifier authority enforcement');
        unauthorizedRejected = true;
      }
      assert(unauthorizedRejected, 'Worker must not approve its own work');
      assert.deepEqual(await creatorClient.getJob(success.address), beforeUnauthorized, 'Unauthorized approval must not mutate chain state');
      manifest.checks.verifierOnlyEnforced = true; await checkpoint();
      const verified = await verifyAndRecordJob({ client: verifierClient, jobAddress: success.address, verifierAddress: verifier.publicKey.toBase58(), spec: success.spec, artifactBytes: await readFile(result.artifactPath), inputPolicy: { allowedOrigins: [INPUT_ORIGIN], allowLoopback: true }, outputDir, trace });
      assert(verified.receipt.approved, 'Valid artifact must pass independent verifier');
      success.receiptPath = verified.receiptPath; await record(success, 'approve', verified.signature);
    }
    assert.equal((await creatorClient.getJob(success.address))?.status, 'VERIFIED');
    await record(success, 'settle', await workerClient.settleJob(success.address, workerAta.address));
  }
  success.balanceEvidence = await balanceEvidence(success, 'settle', workerAta.address, vault);
  await restoreReceipt(success);
  assert.equal((await creatorClient.getJob(success.address))?.status, 'SETTLED');
  await rejectDuplicate(success, workerAta.address, 'settle');
  manifest.checks.exactSettlement = true; manifest.checks.doubleSettlementRejected = true;
  success.status = 'SETTLED'; await checkpoint();

  const failure = await ensureJob('Reject corrupted analysis and refund creator', 2);
  chain = await creatorClient.getJob(failure.address);
  if (chain?.status !== 'REFUNDED') {
    if (!failure.balanceEvidence) { failure.balanceEvidence = { creatorBefore: (await getAccount(connection, creatorAta.address)).amount.toString(), vaultBefore: (await getAccount(connection, creatorClient.vaultAddress(failure.address))).amount.toString() }; await checkpoint(); }
    if (chain?.status === 'FUNDED') await record(failure, 'claim', await workerClient.claimJob(failure.address));
    const corrupt = Buffer.from(JSON.stringify({ version: 1, inputHash: spec.input.hash, rowCount: 999, columns: {}, anomalies: [] }));
    await mkdir('artifacts/analysis', { recursive: true });
    failure.artifactPath = `artifacts/analysis/${failure.address}.artifact.json`; await writeFile(failure.artifactPath, corrupt);
    if ((await creatorClient.getJob(failure.address))?.status === 'CLAIMED') await record(failure, 'submit-corrupt', await workerClient.submitWork(failure.address, sha256(corrupt)));
    if ((await creatorClient.getJob(failure.address))?.status === 'SUBMITTED') {
      const rejected = await verifyAndRecordJob({ client: verifierClient, jobAddress: failure.address, verifierAddress: verifier.publicKey.toBase58(), spec, artifactBytes: corrupt, inputPolicy: { allowedOrigins: [INPUT_ORIGIN], allowLoopback: true }, outputDir: 'artifacts/analysis' });
      assert(!rejected.receipt.approved, 'Corrupted work must fail'); failure.receiptPath = rejected.receiptPath; await record(failure, 'reject', rejected.signature);
    }
    await record(failure, 'refund', await creatorClient.refundJob(failure.address, creatorAta.address));
  }
  failure.balanceEvidence = await balanceEvidence(failure, 'refund', creatorAta.address, creatorClient.vaultAddress(failure.address));
  await restoreReceipt(failure);
  assert.equal((await creatorClient.getJob(failure.address))?.status, 'REFUNDED');
  await rejectDuplicate(failure, creatorAta.address, 'refund');
  failure.status = 'REFUNDED'; manifest.checks.corruptedArtifactRejected = true; manifest.checks.exactRefund = true; manifest.checks.doubleRefundRejected = true;
  manifest.verifiedAt = new Date().toISOString(); await checkpoint();
  await writeFile(process.env.AGENTBOND_DEMO_EVIDENCE ?? `.orchestrator/demo-${network}-evidence.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ network, programId: manifest.programId, mint: manifest.mint, jobs: manifest.jobs.map(j => ({address:j.address,status:j.status})), checks: manifest.checks }, null, 2));
} finally { input?.close(); const lock = JSON.parse(await readFile(lockPath, 'utf8')); if (lock.token === lockToken) await unlink(lockPath); }
