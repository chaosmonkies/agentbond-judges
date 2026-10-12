import { mkdir, writeFile, rename, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jobSpecSchema, specificationHashes, sha256, type JobSpec } from '../../shared/src/index.ts';
import { executeCsv } from './execute.ts';
import { fetchInput, type InputPolicy } from './input.ts';
import { verifyArtifact, type VerificationReceipt } from '../../../apps/verifier/src/verify.ts';
import { verificationReceiptSchema } from '../../../apps/verifier/src/verify.ts';
import { readBoundedArtifact } from '../../../apps/api/src/artifacts.ts';

export interface RuntimeJob {
  address: string; status: string; worker: string | null; verifier: string;
  specHash: string; acceptanceHash: string; artifactHash: string; claimDeadline: number; verificationHash?: string; mint?: string; submitDeadline?: number; verifyDeadline?: number;
}
export interface RuntimeClient {
  getJob(address: string): Promise<RuntimeJob | null>; listJobs(): Promise<RuntimeJob[]>;
  claimJob(address: string): Promise<string>; submitWork(address: string, hash: string): Promise<string>;
  approveWork(address: string, hash: string): Promise<string>; rejectWork(address: string, hash: string): Promise<string>;
}
export interface TraceEvent { time: string; job: string; action: string; signature?: string; hash?: string; error?: string }
type Trace = (event: TraceEvent) => void | Promise<void>;
function validateSpec(job: RuntimeJob, spec: JobSpec) {
  const hashes = specificationHashes(spec);
  if (job.specHash !== hashes.specHash || job.acceptanceHash !== hashes.acceptanceHash) throw new Error('Specification does not match chain commitments');
}
function safeAddress(address: string) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('Invalid job address'); }
async function atomicWrite(path: string, bytes: string | Uint8Array) {
  const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, bytes, { mode: 0o600, flush: true }); await rename(temp, path);
  const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}

export async function runWorkerJob(options: {
  client: RuntimeClient; jobAddress: string; workerAddress: string; spec: JobSpec; outputDir: string;
  inputPolicy: InputPolicy; trace?: Trace;
}) {
  const { client, jobAddress, workerAddress, outputDir, trace } = options;
  safeAddress(jobAddress); const spec = jobSpecSchema.parse(options.spec);
  const emit = async (action: string, extra: Partial<TraceEvent> = {}) => { await trace?.({ time: new Date().toISOString(), job: jobAddress, action, ...extra }); };
  let job = await client.getJob(jobAddress); if (!job) throw new Error('Job not found'); validateSpec(job, spec);
  let claimSignature: string | undefined;
  if (job.status === 'FUNDED') {
    try { claimSignature = await client.claimJob(jobAddress); }
    catch (error) {
      const recovered = await client.getJob(jobAddress);
      if (!recovered || recovered.status !== 'CLAIMED' || recovered.worker !== workerAddress) throw error;
      await emit('claim-reconciled');
    }
    job = await client.getJob(jobAddress); if (!job) throw new Error('Claim state missing');
    await emit('claimed', { signature: claimSignature });
  }
  if (job.worker !== workerAddress) throw new Error('Job belongs to another worker');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(outputDir, `${jobAddress}.artifact.json`);
  if (['SUBMITTED', 'VERIFIED', 'SETTLED'].includes(job.status)) {
    const bytes = await readBoundedArtifact(artifactPath, outputDir);
    if (sha256(bytes) !== job.artifactHash) throw new Error('Recovery artifact differs from chain commitment');
    return { artifact: JSON.parse(bytes.toString()), artifactHash: job.artifactHash, artifactPath, recovered: true, claimSignature, submitSignature: undefined };
  }
  if (job.status !== 'CLAIMED') throw new Error(`Worker cannot execute state ${job.status}`);
  const input = await fetchInput(spec.input.url, spec.input.hash, options.inputPolicy);
  await emit('input-validated', { hash: spec.input.hash });
  const artifact = await executeCsv(input, spec);
  const bytes = JSON.stringify(artifact); const artifactHash = sha256(bytes);
  await atomicWrite(artifactPath, bytes); await emit('executed', { hash: artifactHash });
  let submitSignature: string | undefined;
  try { submitSignature = await client.submitWork(jobAddress, artifactHash); }
  catch (error) {
    const recovered = await client.getJob(jobAddress);
    if (!recovered || !['SUBMITTED', 'VERIFIED', 'SETTLED'].includes(recovered.status) || recovered.artifactHash !== artifactHash || recovered.worker !== workerAddress) throw error;
    await emit('submission-reconciled');
  }
  await emit('submitted', { signature: submitSignature, hash: artifactHash });
  return { artifact, artifactHash, artifactPath, claimSignature, submitSignature, recovered: false };
}

export async function verifyAndRecordJob(options: {
  client: RuntimeClient; jobAddress: string; verifierAddress: string; spec: JobSpec;
  artifactBytes?: Uint8Array; artifactUrl?: string; inputPolicy: InputPolicy; outputDir: string; trace?: Trace;
}) {
  const { client, jobAddress, verifierAddress } = options; safeAddress(jobAddress);
  const job = await client.getJob(jobAddress); if (!job) throw new Error('Job not found');
  if (job.verifier !== verifierAddress) throw new Error('Unauthorized verifier');
  validateSpec(job, options.spec);
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  const receiptPath = join(options.outputDir, `${jobAddress}.receipt.json`);
  let existingBytes: Buffer | null = null;
  try { existingBytes = await readBoundedArtifact(receiptPath, options.outputDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let existingReceipt: VerificationReceipt | null = null;
  if (existingBytes) existingReceipt = verificationReceiptSchema.parse(JSON.parse(existingBytes.toString('utf8')));
  const sameCommitments = (receipt: VerificationReceipt) => receipt.jobAddress === jobAddress && receipt.artifactHash === job.artifactHash && receipt.inputHash === options.spec.input.hash && receipt.specHash === job.specHash;
  if (['VERIFIED', 'SETTLED', 'REJECTED', 'REFUNDED'].includes(job.status)) {
    if (!existingBytes || !existingReceipt || sha256(existingBytes) !== job.verificationHash || !sameCommitments(existingReceipt)) throw new Error('Missing or changed committed verification receipt');
    const approvedStatus = ['VERIFIED', 'SETTLED'].includes(job.status);
    if (existingReceipt.approved !== approvedStatus) throw new Error('Receipt decision differs from chain state');
    return { receipt: existingReceipt, receiptHash: sha256(existingBytes), receiptPath, signature: '', recovered: true };
  }
  if (job.status !== 'SUBMITTED') throw new Error(`Verifier cannot evaluate state ${job.status}`);
  const artifactBytes = options.artifactUrl ? await fetchInput(options.artifactUrl, job.artifactHash, options.inputPolicy) : options.artifactBytes;
  if (!artifactBytes) throw new Error('Artifact bytes or allowlisted download URL required');
  const input = await fetchInput(options.spec.input.url, options.spec.input.hash, options.inputPolicy);
  let receipt: VerificationReceipt = verifyArtifact(input, artifactBytes, job.artifactHash, options.spec, jobAddress);
  // Recompute every retry, but preserve an already-written valid receipt's exact
  // bytes/timestamp. The original approval may still be in flight.
  if (existingReceipt && sameCommitments(existingReceipt) && existingReceipt.approved === receipt.approved && JSON.stringify(existingReceipt.reasons) === JSON.stringify(receipt.reasons)) receipt = existingReceipt;
  else if (existingReceipt) throw new Error('Existing verification receipt differs from independently recomputed result');
  const bytes = existingBytes && existingReceipt === receipt ? existingBytes : Buffer.from(JSON.stringify(receipt));
  const receiptHash = sha256(bytes);
  if (!existingBytes) await atomicWrite(receiptPath, bytes);
  let signature: string;
  try { signature = receipt.approved ? await client.approveWork(jobAddress, receiptHash) : await client.rejectWork(jobAddress, receiptHash); }
  catch (error) {
    const recovered = await client.getJob(jobAddress);
    const states = receipt.approved ? ['VERIFIED', 'SETTLED'] : ['REJECTED', 'REFUNDED'];
    if (!recovered || recovered.verificationHash !== receiptHash || !states.includes(recovered.status)) throw error;
    signature = ''; // Reconciled chain state, never invent a lost signature.
  }
  await options.trace?.({ time: new Date().toISOString(), job: jobAddress, action: receipt.approved ? 'approved' : 'rejected', signature: signature || undefined, hash: receiptHash });
  return { receipt, receiptHash, receiptPath, signature, recovered: false };
}

export async function discoverEligibleJobs(client: Pick<RuntimeClient, 'listJobs'>, getSpec: (address: string) => Promise<JobSpec | null>, allowedOrigins: string[]): Promise<{ job: RuntimeJob; spec: JobSpec }[]> {
  const jobs = await client.listJobs(); const eligible: { job: RuntimeJob; spec: JobSpec }[] = [];
  for (const job of jobs) {
    if (job.status !== 'FUNDED' || job.claimDeadline <= Math.floor(Date.now() / 1000)) continue;
    try {
      const raw = await getSpec(job.address);
      if (!raw) continue;
      const spec = jobSpecSchema.parse(raw);
      if (!allowedOrigins.includes(new URL(spec.input.url).origin)) continue;
      validateSpec(job, spec); eligible.push({ job, spec });
    } catch { /* One malformed or unavailable job must not stop the discovery queue. */ }
  }
  return eligible;
}
