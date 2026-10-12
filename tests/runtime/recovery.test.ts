import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverEligibleJobs, runWorkerJob, verifyAndRecordJob, type RuntimeClient, type RuntimeJob } from '../../packages/agent-runtime/src/pipeline.ts';
import { specificationHashes, sha256, type JobSpec } from '../../packages/shared/src/index.ts';

describe('worker and verifier restart/reconciliation', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  async function setup(lostResponses = false) {
    const csv = Buffer.from('revenue\n1\n200\n');
    const server = createServer((_req, res) => res.end(csv)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const outputDir = await mkdtemp(join(tmpdir(), 'agentbond-recovery-'));
    cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(outputDir, { recursive: true, force: true }); });
    const spec: JobSpec = { type: 'csv-analysis', input: { url: origin + '/input', hash: sha256(csv) }, acceptance: { numericColumns: ['revenue'], anomaly: { column: 'revenue', threshold: 100, direction: 'above' } } };
    const workerAddress = Keypair.generate().publicKey.toBase58(), verifierAddress = Keypair.generate().publicKey.toBase58();
    const job: RuntimeJob & { verificationHash: string } = { address: Keypair.generate().publicKey.toBase58(), status: 'FUNDED', worker: null, verifier: verifierAddress, artifactHash: '0'.repeat(64), verificationHash: '0'.repeat(64), ...specificationHashes(spec), claimDeadline: Math.floor(Date.now() / 1000) + 100 };
    const calls = { claim: 0, submit: 0, approve: 0, reject: 0 };
    const client: RuntimeClient = {
      getJob: async () => ({ ...job }), listJobs: async () => [{ ...job }],
      claimJob: async () => { calls.claim++; job.status = 'CLAIMED'; job.worker = workerAddress; if (lostResponses) throw new Error('Lost claim RPC response'); return 'claim-signature'; },
      submitWork: async (_address, hash) => { calls.submit++; job.status = 'SUBMITTED'; job.artifactHash = hash; if (lostResponses) throw new Error('Lost submit RPC response'); return 'submit-signature'; },
      approveWork: async (_address, hash) => { calls.approve++; job.status = 'VERIFIED'; job.verificationHash = hash; if (lostResponses) throw new Error('Lost approve RPC response'); return 'approve-signature'; },
      rejectWork: async (_address, hash) => { calls.reject++; job.status = 'REJECTED'; job.verificationHash = hash; return 'reject-signature'; },
    };
    return { client, job, spec, calls, outputDir, workerAddress, verifierAddress, inputPolicy: { allowedOrigins: [origin], allowLoopback: true } };
  }
  it('autonomously discovers, claims, executes, submits and independently verifies a job', async () => {
    const env = await setup(); expect(await discoverEligibleJobs(env.client, async () => env.spec, env.inputPolicy.allowedOrigins)).toHaveLength(1);
    const result = await runWorkerJob({ ...env, jobAddress: env.job.address }); expect(env.job.status).toBe('SUBMITTED');
    const verification = await verifyAndRecordJob({ ...env, jobAddress: env.job.address, artifactBytes: await readFile(result.artifactPath) });
    expect(verification.receipt.approved).toBe(true); expect(env.job.status).toBe('VERIFIED'); expect(env.calls).toEqual({ claim: 1, submit: 1, approve: 1, reject: 0 });
  });
  it('reconciles lost responses without replaying claim, submission or approval', async () => {
    const env = await setup(true); const result = await runWorkerJob({ ...env, jobAddress: env.job.address });
    expect(result.submitSignature).toBeUndefined(); expect(result.claimSignature).toBeUndefined();
    const resumed = await runWorkerJob({ ...env, jobAddress: env.job.address }); expect(resumed.recovered).toBe(true);
    const verification = await verifyAndRecordJob({ ...env, jobAddress: env.job.address, artifactBytes: await readFile(result.artifactPath) });
    expect(verification.signature).toBe(''); expect(verification.receipt.approved).toBe(true); expect(env.calls).toEqual({ claim: 1, submit: 1, approve: 1, reject: 0 });
  });
  it('rejects unauthorized verifier, tampered spec and mismatched resumed artifact', async () => {
    const env = await setup(); const wrongSpec = { ...env.spec, input: { ...env.spec.input, hash: 'b'.repeat(64) } };
    await expect(runWorkerJob({ ...env, spec: wrongSpec, jobAddress: env.job.address })).rejects.toThrow('commitments'); expect(env.calls.claim).toBe(0);
    const result = await runWorkerJob({ ...env, jobAddress: env.job.address });
    await expect(verifyAndRecordJob({ ...env, verifierAddress: Keypair.generate().publicKey.toBase58(), jobAddress: env.job.address, artifactBytes: await readFile(result.artifactPath) })).rejects.toThrow('Unauthorized'); expect(env.calls.approve).toBe(0);
    env.job.artifactHash = 'a'.repeat(64); await expect(runWorkerJob({ ...env, jobAddress: env.job.address })).rejects.toThrow('Recovery artifact');
  });
  it('commits a rejection receipt for a deliberately corrupted artifact', async () => {
    const env = await setup(); const result = await runWorkerJob({ ...env, jobAddress: env.job.address });
    const corrupted = { ...result.artifact, rowCount: 1 }; const bytes = Buffer.from(JSON.stringify(corrupted)); env.job.artifactHash = sha256(bytes);
    const verification = await verifyAndRecordJob({ ...env, jobAddress: env.job.address, artifactBytes: bytes });
    expect(verification.receipt.approved).toBe(false); expect(env.job.status).toBe('REJECTED'); expect(env.calls.approve).toBe(0); expect(env.calls.reject).toBe(1);
  });
  it('continues discovery when another job has malformed or unavailable metadata', async () => {
    const env = await setup(); const other = { ...env.job, address: Keypair.generate().publicKey.toBase58() };
    env.client.listJobs = async () => [other, env.job];
    const unavailable = await discoverEligibleJobs(env.client, async address => { if (address === other.address) throw new Error('Metadata RPC unavailable'); return env.spec; }, env.inputPolicy.allowedOrigins);
    expect(unavailable.map(v => v.job.address)).toEqual([env.job.address]);
    const malformed = await discoverEligibleJobs(env.client, async address => address === other.address ? { ...env.spec, input: { hash: '', url: 'invalid' } } : env.spec, env.inputPolicy.allowedOrigins);
    expect(malformed.map(v => v.job.address)).toEqual([env.job.address]);
  });
  it('preserves receipt bytes across a lost approval and terminal restart', async () => {
    const env = await setup(); const output = await runWorkerJob({ ...env, jobAddress: env.job.address });
    const artifactBytes = await readFile(output.artifactPath);
    env.client.approveWork = async () => { env.calls.approve++; throw new Error('Approval response unknown'); };
    await expect(verifyAndRecordJob({ ...env, jobAddress: env.job.address, artifactBytes })).rejects.toThrow('unknown');
    const receiptPath = join(env.outputDir, `${env.job.address}.receipt.json`);
    const original = await readFile(receiptPath); const originalHash = sha256(original);
    env.client.approveWork = async (_address, hash) => { expect(hash).toBe(originalHash); env.calls.approve++; env.job.status = 'SETTLED'; env.job.verificationHash = hash; throw new Error('Lost response after settlement'); };
    const retry = await verifyAndRecordJob({ ...env, jobAddress: env.job.address, artifactBytes });
    expect(retry.receiptHash).toBe(originalHash); expect(await readFile(receiptPath)).toEqual(original);
    const terminal = await verifyAndRecordJob({ ...env, jobAddress: env.job.address });
    expect(terminal.recovered).toBe(true); expect(terminal.signature).toBe(''); expect(env.calls.approve).toBe(2);
    await writeFile(receiptPath, original.toString() + ' ');
    await expect(verifyAndRecordJob({ ...env, jobAddress: env.job.address })).rejects.toThrow('changed committed');
  });
});
