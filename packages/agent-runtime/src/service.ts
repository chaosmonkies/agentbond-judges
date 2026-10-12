import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobSpec } from '../../shared/src/index.ts';
import { jobSpecSchema, specificationHashes } from '../../shared/src/index.ts';
import { runWorkerJob, verifyAndRecordJob, type RuntimeClient, type RuntimeJob } from './pipeline.ts';
import type { InputPolicy } from './input.ts';
import { readBoundedArtifact } from '../../../apps/api/src/artifacts.ts';
import type { Heartbeat } from '../../../apps/api/src/sqlite-store.ts';

export interface ServiceOptions {
  role: 'worker'|'verifier'; client: RuntimeClient; wallet: string; mint: string; verifier: string;
  outputDir: string; inputPolicy: InputPolicy; getSpec(address: string): Promise<JobSpec|null>;
  settle(job: RuntimeJob): Promise<unknown>; heartbeat(value: Heartbeat): void|Promise<void>;
  healthRoot?: string; log?(value: unknown): void; now?: () => number;
  prepare?(): Promise<void>;
}
const cursors = new WeakMap<object, { worker: number; verifier: number }>();
/** Process one bounded snapshot. A failed job never stops unrelated supported jobs. */
export async function runServicePass(options: ServiceOptions) {
  await options.prepare?.();
  const now = options.now ?? Date.now; const jobs = await options.client.listJobs();
  const results: { address: string; action: string; error?: string }[] = [];
  const eligible=jobs.filter(job => job.mint===options.mint && job.verifier===options.verifier && (job.status==='VERIFIED' || (options.role==='worker' && ((job.status==='FUNDED' && job.claimDeadline>Math.floor(now()/1000)) || (job.status==='CLAIMED' && job.worker===options.wallet))) || (options.role==='verifier' && job.status==='SUBMITTED' && job.verifier===options.wallet)));
  const cursor=cursors.get(options.client) ?? {worker:0,verifier:0}; const start=eligible.length ? cursor[options.role]%eligible.length : 0;
  const batch=eligible.length>100 ? [...eligible.slice(start),...eligible.slice(0,start)].slice(0,100) : eligible;
  cursor[options.role]=eligible.length>100 ? (start+100)%eligible.length : 0; cursors.set(options.client,cursor);
  for (const job of batch) {
    try {
      if (job.status === 'VERIFIED') {
        if (!job.worker) throw new Error('Verified job has no worker');
        await options.settle(job); results.push({ address: job.address, action: 'settled' }); continue;
      }
      const workerReady = options.role === 'worker' && ((job.status === 'FUNDED' && job.claimDeadline > Math.floor(now()/1000)) || (job.status === 'CLAIMED' && job.worker === options.wallet));
      const verifierReady = options.role === 'verifier' && job.status === 'SUBMITTED' && job.verifier === options.wallet;
      if (!workerReady && !verifierReady) continue;
      if (job.status === 'CLAIMED' && job.submitDeadline !== undefined && job.submitDeadline <= Math.floor(now()/1000)) continue;
      if (verifierReady && job.verifyDeadline !== undefined && job.verifyDeadline <= Math.floor(now()/1000)) continue;
      const raw = await options.getSpec(job.address); if (!raw) continue; const spec = jobSpecSchema.parse(raw);
      const hashes = specificationHashes(spec);
      if (hashes.specHash !== job.specHash || hashes.acceptanceHash !== job.acceptanceHash) throw new Error('Specification does not match chain commitments');
      // Read and authenticate owned bytes before claiming work. No arbitrary URL fallback.
      if (options.inputPolicy.ownedResolver) await options.inputPolicy.ownedResolver(spec.input.url, spec.input.hash);
      if (workerReady) {
        await runWorkerJob({ client: options.client, jobAddress: job.address, workerAddress: options.wallet, spec, outputDir: options.outputDir, inputPolicy: options.inputPolicy });
        results.push({ address: job.address, action: 'submitted' });
      } else {
        const artifactBytes = await readBoundedArtifact(join(options.outputDir, `${job.address}.artifact.json`), options.outputDir);
        const verification = await verifyAndRecordJob({ client: options.client, jobAddress: job.address, verifierAddress: options.wallet, spec, artifactBytes, outputDir: options.outputDir, inputPolicy: options.inputPolicy });
        results.push({ address: job.address, action: verification.receipt.approved ? 'approved' : 'rejected' });
        if (verification.receipt.approved) {
          const fresh = await options.client.getJob(job.address);
          if (fresh?.status === 'VERIFIED') { await options.settle(fresh); results.push({ address: job.address, action: 'settled' }); }
        }
      }
    } catch (error) { results.push({ address: job.address, action: 'retry', error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
export async function recordServiceHeartbeat(options: Pick<ServiceOptions,'role'|'heartbeat'|'healthRoot'>, healthy: boolean, detail: string) {
  const value: Heartbeat = { service: options.role, time: Date.now(), healthy, detail: detail.slice(0,1000) };
  await options.heartbeat(value);
  if (options.healthRoot) {
    await mkdir(options.healthRoot, { recursive: true, mode: 0o700 });
    const path = join(options.healthRoot, `${options.role}.json`), tmp = path + '.tmp';
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, path);
  }
}
export async function watchService(options: ServiceOptions, controls: { signal?: AbortSignal; intervalMs?: number; initialDelayMs?:number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; maxPasses?: number } = {}) {
  const sleep = controls.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
  }));
  const base = Math.max(1000, Math.min(controls.intervalMs ?? 5000, 30000)); let failures = 0, passes = 0, healthy=false;
  const pulse = setInterval(() => { void recordServiceHeartbeat(options, healthy, 'Continuous service running; current snapshot processing').catch(error => options.log?.({ service:options.role,error:String(error) })); },20000);
  try {
  if((controls.initialDelayMs ?? 0)>0)await sleep(Math.min(15000,controls.initialDelayMs!),controls.signal);
  while (!controls.signal?.aborted && passes++ < (controls.maxPasses ?? Infinity)) {
    try {
      const results = await runServicePass(options); const retries = results.filter(v => v.action === 'retry');
      failures = 0; healthy=retries.length===0; await recordServiceHeartbeat(options, healthy, JSON.stringify({ processed: results.length, retries: retries.length }));
      options.log?.({ service: options.role, results });
    } catch (error) {
      failures++; healthy=false; const message = error instanceof Error ? error.message : String(error);
      await recordServiceHeartbeat(options, false, message); options.log?.({ service: options.role, error: message });
    }
    if (!controls.signal?.aborted && passes < (controls.maxPasses ?? Infinity)) await sleep(Math.min(60000, base * 2 ** Math.min(failures,4)), controls.signal);
  } } finally { clearInterval(pulse); }
}
