import { readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { createChainReader } from '../apps/api/src/reader.ts';
import { SqliteMetadataStore } from '../apps/api/src/sqlite-store.ts';
import { jobSpecSchema, sha256, specificationHashes } from '../packages/shared/src/index.ts';
import { networkProfileFromEnv, verifyNetworkGenesis } from '../packages/shared/src/network.ts';
import { createRuntimeConnection } from '../packages/agent-runtime/src/rpc.ts';

/** Restore only independently authenticated terminal demo history, never active work. */
export async function seedHostedHistory(env: NodeJS.ProcessEnv) {
  if (!env.AGENTBOND_HISTORY_FILE) return;
  const profile = networkProfileFromEnv(env);
  if (profile.network !== 'devnet') throw new Error('Historical devnet data cannot be imported on another network');
  const connection = createRuntimeConnection(profile.rpcUrl); await verifyNetworkGenesis(profile,connection);
  const text = await readFile(env.AGENTBOND_HISTORY_FILE,'utf8');
  if (Buffer.byteLength(text)>2*1024*1024) throw new Error('Historical bundle exceeds limit');
  const snapshot = JSON.parse(text);
  if (snapshot.config.programId !== profile.programId || snapshot.config.mint !== profile.mint || snapshot.config.network !== 'devnet') throw new Error('Historical bundle network mismatch');
  const store = new SqliteMetadataStore(env.AGENTBOND_METADATA_STORE!); await store.load();
  const reader = createChainReader(connection,new PublicKey(profile.programId));
  const root = env.AGENTBOND_ARTIFACT_ROOT!; await mkdir(root,{recursive:true,mode:0o700});
  let restored=0;
  try {
    for (const [address, raw] of Object.entries(snapshot.jobs)) {
      new PublicKey(address);
      const metadata=raw as {title:string;spec:unknown};
      const job=await reader.getJob(address);
      if (!job || !['SETTLED','REFUNDED'].includes(job.status) || job.mint !== profile.mint || job.verifier !== profile.verifier) throw new Error('Historical job is not a supported terminal chain account');
      const spec=jobSpecSchema.parse(metadata.spec), hashes=specificationHashes(spec);
      if (job.specHash!==hashes.specHash || job.acceptanceHash!==hashes.acceptanceHash) throw new Error('Historical specification commitment mismatch');
      for (const type of ['artifact','receipt'] as const) {
        const bytes=Buffer.from(snapshot.artifacts[address][type],'utf8');
        const expected=type==='artifact'?job.artifactHash:job.verificationHash;
        if (bytes.length>2*1024*1024 || sha256(bytes)!==expected) throw new Error('Historical evidence commitment mismatch');
        const path=join(root,`${address}.${type}.json`);
        try { const file=await open(path,'wx',0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; if (sha256(await readFile(path))!==expected) throw new Error('Existing historical evidence differs from commitment'); }
      }
      if (!store.job(address)) await store.putJob({address,title:metadata.title,spec});
      restored++;
    }
  } finally { store.close(); }
  console.log(JSON.stringify({service:'history-bootstrap',verifiedTerminalJobs:restored}));
}
