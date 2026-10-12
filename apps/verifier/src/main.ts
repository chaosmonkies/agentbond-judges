import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBondClient, PROGRAM_ID } from '../../../packages/sdk/src/index.ts';
import { verifyAndRecordJob, loadExternalKeypair } from '../../../packages/agent-runtime/src/index.ts';
import { jobSpecSchema } from '../../../packages/shared/src/index.ts';
import { startHostedRole } from '../../../packages/agent-runtime/src/hosted.ts';

export async function startVerifier() {
  if (process.argv.includes('--watch') || process.env.AGENTBOND_WATCH === '1') return startHostedRole('verifier');
  const keyPath = process.env.AGENTBOND_VERIFIER_KEYPAIR;
  if (!keyPath) throw new Error('AGENTBOND_VERIFIER_KEYPAIR must point to a restricted key outside the repository');
  const key = await loadExternalKeypair(keyPath);
  const programId = process.env.AGENTBOND_PROGRAM_ID ? new PublicKey(process.env.AGENTBOND_PROGRAM_ID) : PROGRAM_ID;
  const client = new AgentBondClient(new Connection(process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed'), new anchor.Wallet(key), programId);
  const api = process.env.AGENTBOND_API_URL ?? 'http://127.0.0.1:4100';
  const allowedOrigins = (process.env.AGENTBOND_INPUT_ORIGINS ?? 'http://127.0.0.1:4100').split(',');
  const outputDir = resolve(process.env.AGENTBOND_ARTIFACT_ROOT ?? 'artifacts'); await mkdir(outputDir, { recursive: true });
  const jobs = (await client.listJobs()).filter(job => job.status === 'SUBMITTED' && job.verifier === key.publicKey.toBase58());
  const results = [];
  for (const job of jobs) {
    const response = await fetch(`${api}/jobs/${job.address}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) continue; const data = await response.json() as { metadata?: { spec?: unknown } };
    if (!data.metadata?.spec) continue;
    const spec = jobSpecSchema.parse(data.metadata.spec);
    // Download the exact committed bytes independently from the input download.
    results.push(await verifyAndRecordJob({ client, jobAddress: job.address, verifierAddress: key.publicKey.toBase58(), spec, artifactUrl: `${api}/jobs/${job.address}/artifacts?raw=artifact`, outputDir, inputPolicy: { allowedOrigins: [...new Set([...allowedOrigins, new URL(api).origin])], allowLoopback: process.env.AGENTBOND_ALLOW_LOOPBACK === '1' }, trace: event => appendFile(join(outputDir, 'verifier-trace.jsonl'), JSON.stringify(event) + '\n') }));
  }
  console.log(JSON.stringify({ discovered: jobs.length, evaluated: results.map(result => ({ approved: result.receipt.approved, signature: result.signature, receiptHash: result.receiptHash })) }));
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startVerifier().catch(error => { console.error(error.message); process.exitCode = 1; });
