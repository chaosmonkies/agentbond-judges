import { afterEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletAuth } from '../../apps/api/src/auth.ts';
import { ChainIndex, type ChainReader, type ChainJob, type ChainEvent } from '../../apps/api/src/indexer.ts';
import { MetadataStore } from '../../apps/api/src/store.ts';
import { sha256 } from '../../packages/shared/src/index.ts';

function signatureHeader(wallet: Keypair, nonce: string, message: string) {
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), wallet.secretKey)).toString('base64');
  return 'AgentBond ' + Buffer.from(JSON.stringify({ wallet: wallet.publicKey.toBase58(), nonce, signature })).toString('base64');
}
describe('wallet authentication', () => {
  const raw = JSON.stringify({ id: 'worker' });
  it('binds wallet, nonce, domain, expiry, action and body then consumes nonce exactly once', () => {
    const wallet = Keypair.generate(), auth = new WalletAuth('agentbond.test');
    const challenge = auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) });
    expect(challenge.message).toContain('Domain: agentbond.test'); expect(challenge.message).toContain('Expires at:');
    const header = signatureHeader(wallet, challenge.nonce, challenge.message);
    expect(auth.authorize(header, 'register-agent', raw)).toBe(wallet.publicKey.toBase58());
    expect(() => auth.authorize(header, 'register-agent', raw)).toThrow('consumed nonce');
  });
  it('rejects altered domain, signer, action and body', () => {
    const wallet = Keypair.generate(), auth = new WalletAuth('agentbond.test');
    const challenge = auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) });
    expect(() => auth.authorize(signatureHeader(wallet, challenge.nonce, challenge.message.replace('agentbond.test', 'phishing.test')), 'register-agent', raw)).toThrow('Invalid wallet signature');
    const header = signatureHeader(wallet, challenge.nonce, challenge.message);
    expect(() => auth.authorize(header, 'job-metadata', raw)).toThrow('scope');
    expect(() => auth.authorize(header, 'register-agent', raw + ' ')).toThrow('scope');
    expect(() => auth.authorize(signatureHeader(Keypair.generate(), challenge.nonce, challenge.message), 'register-agent', raw)).toThrow('scope');
  });
  it('rejects expired and unissued nonces and restricts challenge rate', () => {
    const wallet = Keypair.generate(); let now = 1000000; const auth = new WalletAuth('localhost:3000', () => now);
    const challenge = auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) });
    now += 60000; expect(() => auth.authorize(signatureHeader(wallet, challenge.nonce, challenge.message), 'register-agent', raw)).toThrow('expired');
    expect(() => auth.authorize(signatureHeader(wallet, 'a'.repeat(64), challenge.message), 'register-agent', raw)).toThrow('Unknown');
    for (let i = 0; i < 10; i++) auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) });
    expect(() => auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) })).toThrow('rate limit');
  });
  it('a restart invalidates outstanding challenges instead of accepting replay', () => {
    const wallet = Keypair.generate(), auth = new WalletAuth('test');
    const challenge = auth.challenge({ wallet: wallet.publicKey.toBase58(), action: 'register-agent', bodyHash: sha256(raw) });
    expect(() => new WalletAuth('test').authorize(signatureHeader(wallet, challenge.nonce, challenge.message), 'register-agent', raw)).toThrow('Unknown');
  });
});

describe('chain index reconciliation', () => {
  const job: ChainJob = { address: 'job', status: 'FUNDED', creator: 'creator', worker: null, verifier: 'verifier', amount: '100', specHash: '', acceptanceHash: '', artifactHash: '', verificationHash: '' };
  it('recovers after RPC interruption and never exposes cached jobs as fresh', async () => {
    let offline = false; let state = job;
    const reader: ChainReader = { listJobs: async () => { if (offline) throw new Error('RPC interrupted'); return [state]; }, getJob: async () => state, events: async () => [] };
    const index = new ChainIndex(reader); expect((await index.reconcile())[0].status).toBe('FUNDED');
    offline = true; await expect(index.reconcile()).rejects.toThrow('RPC interrupted'); expect(index.lastError).toBe('RPC interrupted');
    state = { ...job, status: 'SETTLED' }; offline = false;
    expect((await index.reconcile())[0].status).toBe('SETTLED'); expect(index.lastError).toBeNull();
  });
  it('deduplicates signatures, updates finality, and removes rolled-back confirmed observations', async () => {
    let events: ChainEvent[] = [{ signature: 'sig1', slot: 1, blockTime: 1, confirmationStatus: 'confirmed' }, { signature: 'sig1', slot: 1, blockTime: 1, confirmationStatus: 'confirmed' }, { signature: 'failed', slot: 2, blockTime: 1, confirmationStatus: 'confirmed', error: 'instruction error' }];
    const index = new ChainIndex({ listJobs: async () => [job], getJob: async () => job, events: async () => events });
    expect(await index.events('job')).toHaveLength(1);
    events = [{ signature: 'sig1', slot: 1, blockTime: 1, confirmationStatus: 'finalized' }, { signature: 'sig2', slot: 3, blockTime: 2, confirmationStatus: 'confirmed' }];
    expect(await index.events('job')).toHaveLength(2);
    events = []; const reconciled = await index.events('job'); expect(reconciled.map(v => v.signature)).toEqual(['sig1']);
  });
});

describe('atomic metadata storage', () => {
  const paths: string[] = [];
  afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
  it('serializes concurrent writes and recovers actual data across restart', async () => {
    const path = await mkdtemp(join(tmpdir(), 'agentbond-store-')); paths.push(path); const store = new MetadataStore(join(path, 'metadata.json')); await store.load();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.putAgent({ id: `worker-${i}`, wallet: Keypair.generate().publicKey.toBase58(), capabilities: ['csv'], taskTypes: ['csv-analysis'], maxRuntimeMs: 2000 })));
    const reopened = new MetadataStore(join(path, 'metadata.json')); await reopened.load(); expect(reopened.agents()).toHaveLength(10);
  });
});
