import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, Transaction, SystemProgram, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { sendDurableTransaction, resumeDurableTransaction } from '../../packages/agent-runtime/src/transaction-journal.ts';

describe('durable signed-transaction journal', () => {
  const cleanups: string[] = [];
  afterEach(async () => { for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true }); });
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'agentbond-journal-')); cleanups.push(directory);
    const path = join(directory, 'pending.json'), signer = Keypair.generate(), recipient = Keypair.generate();
    const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient.publicKey, lamports: 123 }));
    const identity = 'unit-test-genesis:' + recipient.publicKey.toBase58();
    let status: { confirmationStatus: string; err: unknown } | null = null, height = 90, sends = 0;
    let lostResponse = false, confirmOnSend = true;
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
      getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => height, isBlockhashValid: async () => ({ value: height <= 100, context: { slot: 1 } }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sends++; const journal = JSON.parse(await readFile(path, 'utf8'));
        const signed = Transaction.from(Buffer.from(raw)); expect(journal.signature).toBe(bs58.encode(signed.signature!));
        expect(journal.raw).toBe(Buffer.from(raw).toString('base64')); // Already durable before broadcast.
        if (confirmOnSend) status = { confirmationStatus: 'confirmed', err: null };
        if (lostResponse) throw new Error('Lost send RPC response');
        return journal.signature;
      },
    } as unknown as Pick<Connection,'getLatestBlockhash'|'getSignatureStatuses'|'getBlockHeight'|'sendRawTransaction'|'isBlockhashValid'>;
    return { path, signer, transaction, identity, connection, sends: () => sends, status: (value: typeof status) => { status = value; }, height: (value: number) => { height = value; }, lose: () => { lostResponse = true; }, pending: () => { confirmOnSend = false; } };
  }
  it('persists before broadcast and recovers lost confirmation without a second financial effect', async () => {
    const env = await fixture(); env.lose();
    const result = await sendDurableTransaction(env.connection, env.transaction, env.signer, env.path, env.identity, { polls: 2, intervalMs: 0 });
    expect(result.state).toBe('CONFIRMED'); expect(env.sends()).toBe(1);
    const resumed = await resumeDurableTransaction(env.connection, env.path, env.identity); expect(resumed?.signature).toBe(result.signature); expect(env.sends()).toBe(1);
  });
  it('preserves an ambiguous pending transaction, then resumes its exact original signature', async () => {
    const env = await fixture(); env.pending();
    await expect(sendDurableTransaction(env.connection, env.transaction, env.signer, env.path, env.identity, { polls: 2, intervalMs: 0 })).rejects.toThrow('remains pending');
    const original = JSON.parse(await readFile(env.path, 'utf8')); expect(env.sends()).toBe(1);
    env.status({ confirmationStatus: 'finalized', err: null });
    expect(await resumeDurableTransaction(env.connection, env.path, env.identity)).toMatchObject({ state: 'CONFIRMED', signature: original.signature, finality: 'finalized' }); expect(env.sends()).toBe(1);
  });
  it('requires finalized expiry before abandoning an unknown signature and refuses failed onchain status', async () => {
    const env = await fixture(); env.pending();
    await expect(sendDurableTransaction(env.connection, env.transaction, env.signer, env.path, env.identity, { polls: 1 })).rejects.toThrow('pending');
    env.height(101); expect(await resumeDurableTransaction(env.connection, env.path, env.identity)).toMatchObject({ state: 'EXPIRED' }); expect(env.sends()).toBe(1);
    env.status({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'InsufficientFunds'] } });
    await expect(resumeDurableTransaction(env.connection, env.path, env.identity)).rejects.toThrow('failed onchain'); expect(env.sends()).toBe(1);
  });
  it('rejects wrong network/operation identity or changed signed journal bytes before broadcast', async () => {
    const env = await fixture(); await sendDurableTransaction(env.connection, env.transaction, env.signer, env.path, env.identity, { polls: 2, intervalMs: 0 });
    await expect(resumeDurableTransaction(env.connection, env.path, 'other-network')).rejects.toThrow('identity or validity mismatch');
    const journal = JSON.parse(await readFile(env.path, 'utf8')); journal.messageHash = '0'.repeat(64); await writeFile(env.path, JSON.stringify(journal));
    await expect(resumeDurableTransaction(env.connection, env.path, env.identity)).rejects.toThrow('message mismatch'); expect(env.sends()).toBe(1);
  });
  it('does not abandon a still-valid signed blockhash even if persisted expiry metadata is too low', async () => {
    const env = await fixture(); env.pending();
    await expect(sendDurableTransaction(env.connection, env.transaction, env.signer, env.path, env.identity, { polls: 1 })).rejects.toThrow('pending');
    const journal = JSON.parse(await readFile(env.path, 'utf8')); journal.lastValidBlockHeight = 0; await writeFile(env.path, JSON.stringify(journal));
    await expect(resumeDurableTransaction(env.connection, env.path, env.identity, { polls: 1 })).rejects.toThrow('pending');
    expect(env.sends()).toBe(2); // Same exact signed bytes, not a second signature/effect.
    journal.lastValidBlockHeight = -1; await writeFile(env.path, JSON.stringify(journal));
    await expect(resumeDurableTransaction(env.connection, env.path, env.identity)).rejects.toThrow('validity mismatch'); expect(env.sends()).toBe(2);
  });
  it('concurrent journal callers install and broadcast only one actual signed transaction',async () => {
    const env=await fixture();const second=new Transaction().add(SystemProgram.transfer({fromPubkey:env.signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:999}));
    const results=await Promise.all([sendDurableTransaction(env.connection,env.transaction,env.signer,env.path,env.identity,{polls:2,intervalMs:0}),sendDurableTransaction(env.connection,second,env.signer,env.path,env.identity,{polls:2,intervalMs:0})]);
    expect(results[0].signature).toBe(results[1].signature);const journal=JSON.parse(await readFile(env.path,'utf8'));expect(results[0].signature).toBe(journal.signature);
    // Rebroadcasts may overlap, but every send is the same installed signed bytes.
    expect(env.sends()).toBeGreaterThanOrEqual(1);expect(results.some(value=>value.recovered)).toBe(true);
  });
});
