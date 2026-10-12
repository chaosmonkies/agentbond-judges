import { Connection, PublicKey } from '@solana/web3.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_ID } from '../../../packages/sdk/src/index.ts';
import { agentProfileSchema, jobSpecSchema, specificationHashes } from '../../../packages/shared/src/index.ts';
import { createChainReader } from './reader.ts';
import { createApi, type ApiConfig } from './server.ts';
import { MetadataStore } from './store.ts';
import { SqliteMetadataStore } from './sqlite-store.ts';
import { ImmutableInputStore } from './inputs.ts';
import { networkProfileFromEnv, verifyNetworkGenesis } from '../../../packages/shared/src/network.ts';
import { DevnetFaucet } from './faucet.ts';
import { loadExternalKeypair } from '../../../packages/agent-runtime/src/signing.ts';
import { createRuntimeConnection } from '../../../packages/agent-runtime/src/rpc.ts';
import { randomUUID } from 'node:crypto';

export async function startApi() {
  if (process.env.AGENTBOND_DATA_DIR || process.env.AGENTBOND_METADATA_STORE?.endsWith('.sqlite')) return startPersistentApi();
  const manifestPath = resolve(process.env.AGENTBOND_DEMO_MANIFEST ?? 'artifacts/demo.json');
  let manifest: Record<string, any> = {};
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const config: ApiConfig = {
    programId: process.env.AGENTBOND_PROGRAM_ID ?? manifest.programId ?? PROGRAM_ID.toBase58(),
    mint: process.env.AGENTBOND_MINT ?? manifest.mint ?? '',
    network: process.env.AGENTBOND_NETWORK ?? manifest.network ?? 'localnet',
    rpcUrl: process.env.SOLANA_RPC_URL ?? manifest.rpcUrl ?? 'http://127.0.0.1:8899',
  };
  const reader = createChainReader(new Connection(config.rpcUrl, 'confirmed'), new PublicKey(config.programId));
  const store = new MetadataStore(resolve(process.env.AGENTBOND_METADATA_STORE ?? '.orchestrator/api-metadata.json')); await store.load();
  // The local manifest is only metadata intake. Each job spec is checked against
  // its actual account commitment before being accepted by the API.
  for (const metadata of manifest.jobs ?? []) {
    if (!metadata.spec || !metadata.address) continue;
    const spec = jobSpecSchema.parse(metadata.spec), job = await reader.getJob(metadata.address), hashes = specificationHashes(spec);
    if (job && job.specHash === hashes.specHash && job.acceptanceHash === hashes.acceptanceHash) await store.putJob({ address: metadata.address, title: metadata.title, spec, artifactPath: metadata.artifactPath, receiptPath: metadata.receiptPath });
  }
  // Demo profiles are not silently registered. They must use signed registration.
  const inputFiles = new Map<string, Uint8Array>();
  const csvPath = process.env.AGENTBOND_INPUT_CSV ?? manifest.inputPath;
  if (csvPath) inputFiles.set('/inputs/demo.csv', await readFile(resolve(csvPath)));
  const api = createApi({ config, reader, store, artifactRoot: resolve(process.env.AGENTBOND_ARTIFACT_ROOT ?? 'artifacts'), inputFiles, authDomain: process.env.AGENTBOND_AUTH_DOMAIN, webOrigin: process.env.AGENTBOND_WEB_ORIGIN });
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
  await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.listen(port, process.env.API_HOST ?? '127.0.0.1', resolve); });
  console.log(`AgentBond API http://127.0.0.1:${port}; ${config.network} ${config.programId}`);
  return api;
}
export async function startPersistentApi() {
  const profile = networkProfileFromEnv(process.env), connection = createRuntimeConnection(profile.rpcUrl);
  await verifyNetworkGenesis(profile,connection);
  const dataRoot = resolve(process.env.AGENTBOND_DATA_DIR ?? '/data');
  const store = new SqliteMetadataStore(resolve(process.env.AGENTBOND_METADATA_STORE ?? `${dataRoot}/metadata.sqlite`)); await store.load();
  const inputStore = new ImmutableInputStore(store, process.env.AGENTBOND_INPUT_ROOT ?? `${dataRoot}/inputs`, process.env.AGENTBOND_PUBLIC_API_URL ?? 'https://agentbond-hazel.vercel.app/api');
  const config: ApiConfig = { ...profile, defaultVerifier: profile.verifier, designatedVerifier: profile.verifier, workerAddress:process.env.AGENTBOND_WORKER_ADDRESS, metadataWrites: true, writesEnabled: true, inputUpload: true, faucetEnabled: false };
  let faucet: DevnetFaucet|undefined;
  if (process.env.AGENTBOND_FAUCET_KEYPAIR || process.env.AGENTBOND_MINT_AUTHORITY_KEYPAIR) {
    if (!process.env.AGENTBOND_FAUCET_KEYPAIR || !process.env.AGENTBOND_MINT_AUTHORITY_KEYPAIR) throw new Error('Both separate faucet and mint authority key files are required');
    faucet = new DevnetFaucet({connection,profile,store,solKey:await loadExternalKeypair(process.env.AGENTBOND_FAUCET_KEYPAIR),mintAuthority:await loadExternalKeypair(process.env.AGENTBOND_MINT_AUTHORITY_KEYPAIR),journalRoot:resolve(process.env.AGENTBOND_TRANSACTION_JOURNAL ?? `${dataRoot}/journals`),maxWallets:Number(process.env.AGENTBOND_FAUCET_MAX_WALLETS ?? 50)}); await faucet.initialize(); config.faucetEnabled=true;
  }
  const owner=randomUUID(); if (!store.acquireLease('api',owner,Date.now(),15000)) { store.close(); throw new Error('Another persistent API process holds the single-writer service lease'); }
  const api = createApi({ config, reader: createChainReader(connection,new PublicKey(profile.programId)), store, inputStore, faucet, heartbeats: () => store.heartbeats(), artifactRoot: resolve(process.env.AGENTBOND_ARTIFACT_ROOT ?? `${dataRoot}/artifacts`), authDomain: process.env.AGENTBOND_AUTH_DOMAIN ?? new URL(inputStore.publicApiUrl).host, webOrigin: process.env.AGENTBOND_WEB_ORIGIN ?? new URL(inputStore.publicApiUrl).origin });
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
  await new Promise<void>((resolve,reject) => { api.server.once('error',reject); api.server.listen(port,process.env.API_HOST ?? '127.0.0.1',resolve); });
  const renewal=setInterval(() => { if (!store.acquireLease('api',owner,Date.now(),15000)) { console.error('Persistent API single-writer lease lost'); api.server.close(); } },5000);
  api.server.once('close',() => { clearInterval(renewal); store.releaseLease('api',owner); store.close(); }); console.log(JSON.stringify({ service:'api',port,network:profile.network,programId:profile.programId,persistent:true })); return api;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startApi().catch(error => { console.error(error.message); process.exitCode = 1; });
