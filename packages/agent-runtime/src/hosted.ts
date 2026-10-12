import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { resolve, join } from 'node:path';
import { AgentBondClient } from '../../sdk/src/index.ts';
import { networkProfileFromEnv, verifyNetworkGenesis } from '../../shared/src/network.ts';
import { SqliteMetadataStore } from '../../../apps/api/src/sqlite-store.ts';
import { ImmutableInputStore } from '../../../apps/api/src/inputs.ts';
import { loadExternalKeypair } from './signing.ts';
import { watchService, runServicePass, recordServiceHeartbeat, type ServiceOptions } from './service.ts';
import { createRuntimeConnection } from './rpc.ts';
import { registerHostedProfile } from './registration.ts';

export async function startHostedRole(role: 'worker'|'verifier', watch = true) {
  const profile = networkProfileFromEnv(process.env);
  const keyPath = process.env[role === 'worker' ? 'AGENTBOND_WORKER_KEYPAIR' : 'AGENTBOND_VERIFIER_KEYPAIR'];
  if (!keyPath) throw new Error(`External ${role} keypair is required`);
  const key = await loadExternalKeypair(keyPath);
  if (role === 'verifier' && key.publicKey.toBase58() !== profile.verifier) throw new Error('Verifier signer does not match network profile');
  const connection = createRuntimeConnection(profile.rpcUrl); await verifyNetworkGenesis(profile, connection);
  const client = new AgentBondClient(connection, new anchor.Wallet(key), new PublicKey(profile.programId), { networkProfile: profile });
  const dataRoot = resolve(process.env.AGENTBOND_DATA_DIR ?? '/data');
  const store = new SqliteMetadataStore(resolve(process.env.AGENTBOND_METADATA_STORE ?? join(dataRoot,'metadata.sqlite'))); await store.load();
  const inputStore = new ImmutableInputStore(store, process.env.AGENTBOND_INPUT_ROOT ?? join(dataRoot,'inputs'), process.env.AGENTBOND_PUBLIC_API_URL ?? 'https://agentbond-hazel.vercel.app/api');
  let registered=false,lastAttempt=0;
  const options: ServiceOptions = {
    role, client, wallet: key.publicKey.toBase58(), mint: profile.mint, verifier: profile.verifier,
    outputDir: resolve(process.env.AGENTBOND_ARTIFACT_ROOT ?? join(dataRoot,'artifacts')),
    inputPolicy: { allowedOrigins: [new URL(inputStore.publicApiUrl).origin], ownedResolver: (url,hash) => inputStore.resolveOwned(url,hash) },
    getSpec: async address => store.job(address)?.spec ?? null,
    prepare: async () => {
      if (registered || Date.now()-lastAttempt<30000) return; lastAttempt=Date.now();
      try { await registerHostedProfile(process.env.AGENTBOND_API_URL ?? 'http://127.0.0.1:4100',process.env.AGENTBOND_AUTH_DOMAIN ?? new URL(inputStore.publicApiUrl).host,role,key); registered=true; }
      catch (error) { console.error(JSON.stringify({service:role,registrationError:error instanceof Error?error.message:String(error)})); }
    },
    settle: async job => {
      try { return await client.settleJobToWorker(job.address); }
      catch (error) { const fresh = await client.getJob(job.address); if (fresh?.status !== 'SETTLED' || fresh.worker !== job.worker || fresh.mint !== profile.mint) throw error; return { recovered: true }; }
    },
    heartbeat: value => store.heartbeat(value), healthRoot: resolve(process.env.AGENTBOND_HEALTH_ROOT ?? join(dataRoot,'health')),
    log: value => console.log(JSON.stringify(value)),
  };
  const abort = new AbortController(); const stop = () => abort.abort(); process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    if (watch) await watchService(options, { signal: abort.signal, intervalMs: Number(process.env.AGENTBOND_POLL_MS ?? (role==='worker'?12000:15000)), initialDelayMs:role==='worker'?0:6000 });
    else { const results = await runServicePass(options); await recordServiceHeartbeat(options, !results.some(v => v.error), JSON.stringify({ processed: results.length })); return results; }
  } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); store.close(); }
}
