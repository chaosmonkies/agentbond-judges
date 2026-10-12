import { afterEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApi } from '../../apps/api/src/server.ts';
import { MetadataStore } from '../../apps/api/src/store.ts';
import type { ChainJob } from '../../apps/api/src/indexer.ts';
import { sha256, specificationHashes, type JobSpec } from '../../packages/shared/src/index.ts';

describe('HTTP API authorization and chain authority', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'agentbond-api-')); const store = new MetadataStore(join(directory, 'data.json')); await store.load();
    const creator = Keypair.generate(); const address = Keypair.generate().publicKey.toBase58();
    const spec: JobSpec = { type: 'csv-analysis', input: { url: 'http://127.0.0.1:4100/inputs/demo.csv', hash: sha256('revenue\n1\n') }, acceptance: { numericColumns: ['revenue'], anomaly: { column: 'revenue', threshold: 10, direction: 'above' } } };
    const job: ChainJob = { address, status: 'FUNDED', creator: creator.publicKey.toBase58(), worker: null, verifier: Keypair.generate().publicKey.toBase58(), amount: '42', artifactHash: '0'.repeat(64), verificationHash: '0'.repeat(64), ...specificationHashes(spec) };
    let offline = false;
    const api = createApi({ config: { programId: '', mint: '', network: 'unit-test', rpcUrl: '' }, artifactRoot: directory, store, reader: { listJobs: async () => { if (offline) throw new Error('RPC offline'); return [job]; }, getJob: async value => value === address ? job : null, events: async () => [] } });
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;
    cleanups.push(async () => { await new Promise<void>(resolve => api.server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    async function authorized(wallet: Keypair, action: string, value: unknown, route: string) {
      const raw = JSON.stringify(value);
      const challengeResponse = await fetch(origin + '/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), action, bodyHash: sha256(raw) }) });
      const challenge = await challengeResponse.json() as { nonce: string; message: string };
      const signature = Buffer.from(nacl.sign.detached(Buffer.from(challenge.message), wallet.secretKey)).toString('base64');
      const header = 'AgentBond ' + Buffer.from(JSON.stringify({ wallet: wallet.publicKey.toBase58(), nonce: challenge.nonce, signature })).toString('base64');
      const send = () => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: header }, body: raw });
      return { response: await send(), send };
    }
    return { origin, job, spec, creator, authorized, store, directory, offline: (value: boolean) => { offline = value; } };
  }
  it('requires signed agent registration; signer cannot register another wallet or steal an ID', async () => {
    const env = await setup(); const worker = Keypair.generate(); const attacker = Keypair.generate();
    const profile = { id: 'worker', wallet: worker.publicKey.toBase58(), capabilities: ['csv'], taskTypes: ['csv-analysis'], maxRuntimeMs: 2000 };
    expect((await fetch(env.origin + '/agents/register', { method: 'POST', body: JSON.stringify(profile) })).status).toBe(401);
    expect((await env.authorized(attacker, 'register-agent', profile, '/agents/register')).response.status).toBe(403);
    const valid = await env.authorized(worker, 'register-agent', profile, '/agents/register'); expect(valid.response.status).toBe(201); expect((await valid.send()).status).toBe(401);
    const stolen = { ...profile, wallet: attacker.publicKey.toBase58() };
    expect((await env.authorized(attacker, 'register-agent', stolen, '/agents/register')).response.status).toBe(403);
    expect(env.store.agents()).toHaveLength(1);
  });
  it('only permits chain creator to save specification metadata matching both commitments', async () => {
    const env = await setup(); const body = { address: env.job.address, title: 'CSV analysis', spec: env.spec };
    expect((await env.authorized(Keypair.generate(), 'job-metadata', body, '/jobs')).response.status).toBe(403);
    const modified = { ...body, spec: { ...env.spec, acceptance: { ...env.spec.acceptance, anomaly: { ...env.spec.acceptance.anomaly, threshold: 100 } } } };
    expect((await env.authorized(env.creator, 'job-metadata', modified, '/jobs')).response.status).toBe(409);
    expect((await env.authorized(env.creator, 'job-metadata', body, '/jobs')).response.status).toBe(201);
    const detail = await (await fetch(env.origin + '/jobs/' + env.job.address)).json() as { job: ChainJob; metadata: { title: string } };
    expect(detail.job.status).toBe('FUNDED'); expect(detail.metadata.title).toBe('CSV analysis');
  });
  it('returns actual chain counts and an explicit failure after RPC loss then recovers', async () => {
    const env = await setup(); const actual = await (await fetch(env.origin + '/stats')).json() as { totalJobs: number; settledJobs: number; registeredAgents: number };
    expect(actual.totalJobs).toBe(1); expect(actual.settledJobs).toBe(0); expect(actual.registeredAgents).toBe(0);
    env.offline(true); const failed = await fetch(env.origin + '/jobs'); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ jobs: [], error: 'RPC offline' });
    env.job.status = 'SETTLED'; env.offline(false); const recovered = await (await fetch(env.origin + '/jobs')).json() as { jobs: ChainJob[] }; expect(recovered.jobs[0].status).toBe('SETTLED');
  });
  it('discovers worker output without metadata path; serves exact committed bytes and rejects uncommitted tampering', async () => {
    const env = await setup(); const route = `${env.origin}/jobs/${env.job.address}/artifacts`;
    const absent = await fetch(route); expect(absent.status).toBe(200); expect(await absent.json()).toEqual({ artifact: null, receipt: null });
    expect((await fetch(route + '?raw=artifact')).status).toBe(404);
    const committed = JSON.stringify({ version: 1, rowCount: 1 });
    env.job.artifactHash = sha256(committed); await writeFile(join(env.directory, `${env.job.address}.artifact.json`), committed);
    const raw = await fetch(route + '?raw=artifact'); expect(raw.status).toBe(200); expect(await raw.text()).toBe(committed);
    const envelope = await (await fetch(route)).json() as { artifact: { hash: string; content: unknown; matchesChainCommitment: boolean }; receipt: unknown };
    expect(envelope.artifact).toEqual({ hash: env.job.artifactHash, committedHash: env.job.artifactHash, matchesChainCommitment: true, content: JSON.parse(committed) }); expect(envelope.receipt).toBeNull();
    await writeFile(join(env.directory, `${env.job.address}.artifact.json`), committed + ' ');
    expect((await fetch(route + '?raw=artifact')).status).toBe(409); expect((await fetch(route)).status).toBe(409);
  });
});
