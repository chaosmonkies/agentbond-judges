import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve, sep, join } from 'node:path';
import { z } from 'zod';
import { agentProfileSchema, jobSpecSchema, sha256, specificationHashes } from '../../../packages/shared/src/index.ts';
import { WalletAuth } from './auth.ts';
import { ChainIndex, type ChainReader } from './indexer.ts';
import type { MetadataRepository } from './store.ts';
import { readBoundedArtifact } from './artifacts.ts';
import { ImmutableInputStore } from './inputs.ts';
import type { Heartbeat } from './sqlite-store.ts';

const metadataSchema = z.object({ address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), title: z.string().min(1).max(200).optional(), spec: jobSpecSchema }).strict();
export interface ApiConfig { programId: string; mint: string; network: string; rpcUrl: string; defaultVerifier?: string; designatedVerifier?: string; workerAddress?: string; metadataWrites?: boolean; writesEnabled?: boolean; inputUpload?: boolean; decimals?: number; tokenName?: string; faucetEnabled?: boolean }
export interface ApiOptions { config: ApiConfig; reader: ChainReader; store: MetadataRepository; authDomain?: string; webOrigin?: string; artifactRoot: string; inputFiles?: Map<string, Uint8Array>; inputStore?: ImmutableInputStore; heartbeats?: () => Heartbeat[]; faucet?: { request(wallet: string): Promise<unknown>; status?(): unknown } }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function rawBody(req: IncomingMessage, max = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw new HttpError(413, 'Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage) { return (await rawBody(req)).toString('utf8'); }
export function createApi(options: ApiOptions) {
  const bootId=randomUUID(),startedAtMs=Date.now(),startedAt=new Date(startedAtMs).toISOString();
  const index = new ChainIndex(options.reader,{cacheMs:options.inputStore?750:0,knownAddresses:()=>options.store.jobs().map(job=>job.address)}); const auth = new WalletAuth(options.authDomain ?? 'localhost:3000');
  const origin = options.webOrigin ?? 'http://localhost:3000'; const artifacts = resolve(options.artifactRoot);
  let active = 0, streams = 0, window = Date.now(), requests = 0, challenges = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (active >= 32) { send(429,{error:'API concurrency capacity reached'}); return; }
    if (Date.now()-window >= 60000) { window=Date.now(); requests=0; challenges=0; }
    if (++requests > 1200) { send(429,{error:'API request rate limit'}); return; }
    active++; let released=false; const release = () => { if (!released) { released=true; active--; } }; res.once('close',release); res.once('finish',release);
    req.setTimeout(10000,() => req.destroy());
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url ?? '/', 'http://localhost'); const path = url.pathname;
      if (req.method === 'POST' && path !== '/auth/challenge' && (options.config.metadataWrites === false || options.config.writesEnabled === false)) throw new HttpError(503,'Wallet mutations are disabled');
      if (req.method === 'GET' && path === '/health') {
        const services = options.heartbeats?.().map(value => ({ ...value, stale: Date.now() - value.time > 120000 })) ?? [];
        send(200, { ok: true, apiReady: true, bootId, startedAt, workersReady: ['worker','verifier'].every(role => services.some(value => value.service === role && value.healthy && !value.stale && value.time>=startedAtMs)), chainAuthority: 'Solana RPC', lastSuccessfulRead: index.lastSuccessfulRead, lastError: index.lastError, services }); return;
      }
      if (req.method === 'GET' && path === '/config') { send(200, {...options.config,faucet:options.faucet?.status?.() ?? null}); return; }
      if (req.method === 'GET' && path.startsWith('/inputs/')) {
        const owned = /^\/inputs\/([0-9a-f]{64})\.csv$/.exec(path);
        const bytes = owned && options.inputStore ? await options.inputStore.get(owned[1]) : options.inputFiles?.get(path); if (!bytes) throw new HttpError(404, 'Input not found');
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': bytes.length }); res.end(bytes); return;
      }
      if (req.method === 'POST' && path === '/inputs') {
        if (!options.inputStore || options.config.inputUpload === false) throw new HttpError(503, 'Persistent input uploads are not configured');
        if (!/^text\/csv(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be text/csv with UTF-8 bytes');
        const raw = await rawBody(req, 1024 * 1024); const wallet = auth.authorize(req.headers.authorization, 'upload-input', raw);
        const input = await options.inputStore.put(raw, wallet); send(201, { input: { url: options.inputStore.url(input.hash), hash: input.hash, bytes: input.bytes } }); return;
      }
      if (req.method === 'POST' && path === '/faucet') {
        if (!options.faucet || !options.config.faucetEnabled) throw new HttpError(503, 'Devnet faucet is not configured');
        const raw = await body(req); const wallet = auth.authorize(req.headers.authorization, 'request-faucet', raw);
        const request = z.object({ wallet: z.string() }).strict().parse(JSON.parse(raw));
        if (request.wallet !== wallet) throw new HttpError(403, 'Faucet recipient must match signer');
        send(200, { funding: await options.faucet.request(wallet) }); return;
      }
      if (req.method === 'POST' && path === '/auth/challenge') { if (++challenges > 200) throw new HttpError(429,'Challenge rate limit'); send(200, auth.challenge(JSON.parse(await body(req)))); return; }
      if (req.method === 'POST' && path === '/agents/register') {
        const raw = await body(req); const wallet = auth.authorize(req.headers.authorization, 'register-agent', raw);
        const profile = agentProfileSchema.parse(JSON.parse(raw));
        if (wallet !== profile.wallet) throw new HttpError(403, 'Profile wallet must match signer');
        const reserved = profile.id==='independent-verifier' ? options.config.defaultVerifier : profile.id==='csv-worker' ? options.config.workerAddress : undefined;
        if (reserved && wallet!==reserved) throw new HttpError(403,'Service profile ID belongs to the configured role wallet');
        const prior = options.store.agents().find(v => v.id === profile.id);
        if (prior && prior.wallet !== wallet) throw new HttpError(403, 'Agent ID belongs to another wallet');
        await options.store.putAgent(profile); send(201, { agent: profile }); return;
      }
      if (req.method === 'POST' && path === '/jobs') {
        const raw = await body(req); const wallet = auth.authorize(req.headers.authorization, 'job-metadata', raw);
        const metadata = metadataSchema.parse(JSON.parse(raw)); const job = await index.get(metadata.address);
        if (!job) throw new HttpError(404, 'Chain job does not exist');
        if (job.creator !== wallet) throw new HttpError(403, 'Metadata signer must be chain creator');
        if (options.config.defaultVerifier && (job.mint !== options.config.mint || job.verifier !== options.config.defaultVerifier)) throw new HttpError(409, 'Job uses an unsupported mint or verifier');
        const hashes = specificationHashes(metadata.spec);
        if (job.specHash !== hashes.specHash || job.acceptanceHash !== hashes.acceptanceHash) throw new HttpError(409, 'Metadata differs from chain commitments');
        if (options.inputStore) await options.inputStore.resolveOwned(metadata.spec.input.url, metadata.spec.input.hash);
        const existing = options.store.job(metadata.address);
        await options.store.putJob({ ...existing, ...metadata }); index.invalidateSnapshot(); send(201, { metadata }); return;
      }
      if (req.method === 'GET' && path === '/jobs') {
        try { const jobs = await index.reconcile(); send(200, { jobs: jobs.map(job => ({ ...job, metadata: options.store.job(job.address) })), authority: 'chain', observedAt:index.lastSnapshotRead,snapshotReuseMs:options.inputStore?750:0 }); }
        catch (error) { send(503, { jobs: [], error: error instanceof Error ? error.message : String(error) }); } return;
      }
      if (req.method === 'GET' && path === '/agents') { send(200, { agents: options.store.agents(), authority: 'local signed metadata' }); return; }
      if (req.method === 'GET' && path.startsWith('/agents/')) { const agent = options.store.agents().find(v => v.id === decodeURIComponent(path.slice(8))); if (!agent) throw new HttpError(404, 'Agent not found'); send(200, { agent }); return; }
      if (req.method === 'GET' && path === '/stats') {
        const jobs = await index.reconcile(); const byStatus: Record<string, number> = {};
        for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
        send(200, { totalJobs: jobs.length, settledJobs: byStatus.SETTLED ?? 0, fundedJobs: jobs.filter(v => ['FUNDED', 'CLAIMED', 'SUBMITTED', 'VERIFIED'].includes(v.status)).length, registeredAgents: options.store.agents().length, byStatus, authority: 'chain',observedAt:index.lastSnapshotRead,snapshotReuseMs:options.inputStore?750:0 }); return;
      }
      const match = /^\/jobs\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/(events|artifacts))?$/.exec(path);
      if (req.method === 'GET' && match) {
        const address = match[1], route = match[2]; const job = await index.get(address);
        if (!job) throw new HttpError(404, 'Job not found');
        const metadata = options.store.job(address);
        if (route === 'events') {
          if (req.headers.accept === 'text/event-stream') {
            if (streams >= 8) throw new HttpError(429,'Event stream capacity reached'); streams++;
            let timer: ReturnType<typeof setInterval>|undefined, expiry: ReturnType<typeof setTimeout>|undefined, cleaned=false;
            const cleanup = () => { if (cleaned) return; cleaned=true; clearInterval(timer); clearTimeout(expiry); streams--; };
            res.once('close',cleanup);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
            let busy=false; const emit = async () => { if (busy || res.destroyed) return; busy=true; try { const current = await index.get(address); res.write(`event: job\ndata: ${JSON.stringify({ job: current, events: await index.events(address) })}\n\n`); } catch (error) { if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`); } finally { busy=false; } };
            await emit(); if (res.destroyed || cleaned) { cleanup(); return; }
            timer=setInterval(() => { void emit(); },5000); expiry=setTimeout(() => res.end(),60000); return;
          }
          send(200, { events: await index.events(address) }); return;
        }
        if (route === 'artifacts') {
          const rawType = url.searchParams.get('raw');
          if (rawType !== null && rawType !== 'artifact' && rawType !== 'receipt') throw new HttpError(400,'Unknown raw artifact type');
          if (rawType === 'artifact' || rawType === 'receipt') {
            const full = resolve((rawType === 'artifact' ? metadata?.artifactPath : metadata?.receiptPath) ?? join(artifacts, `${address}.${rawType}.json`));
            if (!full.startsWith(artifacts + sep)) throw new HttpError(403, 'Artifact outside configured directory');
            const bytes = await readBoundedArtifact(full, artifacts);
            if (sha256(bytes) !== (rawType === 'artifact' ? job.artifactHash : job.verificationHash)) throw new HttpError(409, 'Artifact differs from chain commitment');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length }); res.end(bytes); return;
          }
          const load = async (path: string | undefined, expected: string, type: 'artifact' | 'receipt') => {
            const full = resolve(path ?? join(artifacts, `${address}.${type}.json`));
            if (!full.startsWith(artifacts + sep)) throw new HttpError(403, 'Artifact outside configured directory');
            let bytes: Buffer;
            try { bytes = await readBoundedArtifact(full, artifacts); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
            const hash = sha256(bytes);
            if (hash !== expected) throw new HttpError(409, 'Artifact differs from chain commitment');
            return { hash, committedHash: expected, matchesChainCommitment: true, content: JSON.parse(bytes.toString('utf8')) };
          };
          send(200, { artifact: await load(metadata?.artifactPath, job.artifactHash, 'artifact'), receipt: await load(metadata?.receiptPath, job.verificationHash, 'receipt') }); return;
        }
        send(200, { job, metadata, authority: 'chain' }); return;
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' || /Input not found/i.test(String(error)) ? 404 : error instanceof z.ZodError || error instanceof SyntaxError || /CSV requires|encoded data|exact owned|Invalid input/i.test(String(error)) ? 400 : /quota|capacity|rate limit/i.test(String(error)) ? 429 : /belongs to another wallet|outside configured directory/i.test(String(error)) ? 403 : /artifact limit|byte limit/i.test(String(error)) ? 413 : /authorization|nonce|signature|scope|signing public key/i.test(String(error)) ? 401 : 503;
      if (!res.headersSent) send(status, { error: error instanceof Error ? error.message : String(error) }); else res.end();
    }
  });
  server.maxConnections=128; server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=5000;
  return { server, auth, index };
}
