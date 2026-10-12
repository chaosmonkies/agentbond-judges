import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '../packages/sdk/src/index.ts';
import { createChainReader } from '../apps/api/src/reader.ts';
import { jobSpecSchema, specificationHashes } from '../packages/shared/src/index.ts';
import { createApi } from '../apps/api/src/server.ts';
import { MetadataStore } from '../apps/api/src/store.ts';
import { inputServer, INPUT_ORIGIN, CSV } from './inputs.ts';
import { loggedProcess, rpcReady, run, waitFor } from './process.ts';
import type { ChildProcess } from 'node:child_process';
import { ensureKeys } from './keys.ts';
import { access } from 'node:fs/promises';

const owned: ChildProcess[] = [];
const rpcUrl = 'http://127.0.0.1:8899';
const deployerFile = join(await ensureKeys(), 'deployer.json');
await mkdir('artifacts', { recursive: true });
await mkdir('.orchestrator', { recursive: true });
if (!(await rpcReady(rpcUrl))) {
  await run('anchor', ['build']);
  owned.push(loggedProcess('local-validator', 'solana-test-validator', ['--ledger', '.orchestrator/ledger', '--rpc-port', '8899', '--faucet-port', '9900', '--upgradeable-program', PROGRAM_ID.toBase58(), 'target/deploy/agentbond.so', deployerFile, '--quiet']));
  await waitFor(() => rpcReady(rpcUrl), 60000);
}
const connection = new Connection(rpcUrl, 'confirmed');
if (!(await connection.getAccountInfo(PROGRAM_ID))?.executable) throw new Error('Port8899 hosts a different validator. Will not alter an unknown running chain.');
if (!await fetch(INPUT_ORIGIN + '/health').then(r => r.ok).catch(() => false)) {
  const server = await inputServer(); process.on('SIGINT', () => server.close()); process.on('SIGTERM', () => server.close());
}
let manifest;
try { manifest = JSON.parse(await readFile('artifacts/demo.json', 'utf8')); }
catch { await run(process.execPath, ['--import','tsx','scripts/demo.ts']); manifest = JSON.parse(await readFile('artifacts/demo.json','utf8')); }
const manifestRpc = manifest.rpcUrl as string;
const readConnection = new Connection(manifestRpc, 'confirmed');
const reader = createChainReader(readConnection,new PublicKey(manifest.programId));
if (!await fetch('http://127.0.0.1:4100/health').then(r => r.ok).catch(() => false)) {
  const store = new MetadataStore(`artifacts/metadata-${manifest.network}.json`); await store.load();
  for (const job of manifest.jobs) {
    const spec = jobSpecSchema.parse(job.spec), hashes = specificationHashes(spec), chain = await reader.getJob(job.address);
    if (!chain || chain.specHash !== hashes.specHash || chain.acceptanceHash !== hashes.acceptanceHash) throw new Error('Demo metadata differs from chain commitments');
    await store.putJob({address:job.address,title:job.title,spec,artifactPath:job.artifactPath,receiptPath:job.receiptPath});
  }
  const api = createApi({ config: { programId:manifest.programId,mint:manifest.mint,network:manifest.network,rpcUrl:manifestRpc,decimals:manifest.decimals,tokenName:manifest.tokenName } as any, reader, store, artifactRoot: 'artifacts', inputFiles: new Map([['/inputs/demo.csv',CSV]]) });
  api.server.listen(4100,'127.0.0.1'); await once(api.server,'listening');
  process.on('SIGINT', () => api.server.close()); process.on('SIGTERM', () => api.server.close());
}
if (!await fetch('http://localhost:3000').then(r => r.ok).catch(() => false)) {
  try { await access('apps/web/.next/BUILD_ID'); } catch { await run('npm',['run','build','--workspace=apps/web']); }
  owned.push(loggedProcess('web', 'npm', ['run','start','--workspace=apps/web']));
}
await waitFor(() => fetch('http://localhost:3000').then(r => r.ok).catch(() => false),60000);
await writeFile('.orchestrator/processes.json',JSON.stringify({rootPid:process.pid,owned:owned.map(c=>({pid:c.pid,spawnargs:c.spawnargs})),api:'http://127.0.0.1:4100',web:'http://localhost:3000',rpc:manifestRpc},null,2));
console.log(`AgentBond ready: http://localhost:3000 · API http://localhost:4100 · ${manifest.network}`);
const stop = () => { for (const child of owned) child.kill('SIGTERM'); setTimeout(() => process.exit(0),500).unref(); };
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await new Promise(() => {});
