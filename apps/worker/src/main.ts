import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBondClient, PROGRAM_ID } from '../../../packages/sdk/src/index.ts';
import { discoverEligibleJobs, runWorkerJob, loadExternalKeypair } from '../../../packages/agent-runtime/src/index.ts';
import { jobSpecSchema } from '../../../packages/shared/src/index.ts';
import { startHostedRole } from '../../../packages/agent-runtime/src/hosted.ts';

export async function startWorker() {
  if (process.argv.includes('--watch') || process.env.AGENTBOND_WATCH === '1') return startHostedRole('worker');
  const keyPath = process.env.AGENTBOND_WORKER_KEYPAIR;
  if (!keyPath) throw new Error('AGENTBOND_WORKER_KEYPAIR must point to a restricted key outside the repository');
  const key = await loadExternalKeypair(keyPath);
  const programId = process.env.AGENTBOND_PROGRAM_ID ? new PublicKey(process.env.AGENTBOND_PROGRAM_ID) : PROGRAM_ID;
  const client = new AgentBondClient(new Connection(process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed'), new anchor.Wallet(key), programId);
  const api = process.env.AGENTBOND_API_URL ?? 'http://127.0.0.1:4100';
  const allowedOrigins = (process.env.AGENTBOND_INPUT_ORIGINS ?? 'http://127.0.0.1:4100').split(',');
  const outputDir = resolve(process.env.AGENTBOND_ARTIFACT_ROOT ?? 'artifacts'); await mkdir(outputDir, { recursive: true });
  const jobs = await discoverEligibleJobs(client, async address => {
    const response = await fetch(`${api}/jobs/${address}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null; const result = await response.json() as { metadata?: { spec?: unknown } };
    return result.metadata?.spec ? jobSpecSchema.parse(result.metadata.spec) : null;
  }, allowedOrigins);
  const results = [];
  for (const { job, spec } of jobs) results.push(await runWorkerJob({ client, jobAddress: job.address, workerAddress: key.publicKey.toBase58(), spec, outputDir, inputPolicy: { allowedOrigins, allowLoopback: process.env.AGENTBOND_ALLOW_LOOPBACK === '1' }, trace: event => appendFile(join(outputDir, 'worker-trace.jsonl'), JSON.stringify(event) + '\n') }));
  console.log(JSON.stringify({ discovered: jobs.length, submitted: results.map(result => ({ artifactHash: result.artifactHash, submitSignature: result.submitSignature })) }));
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startWorker().catch(error => { console.error(error.message); process.exitCode = 1; });
