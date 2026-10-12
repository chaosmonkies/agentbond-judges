import { describe, expect, it, vi } from 'vitest';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, MintLayout } from '@solana/spl-token';
import { AgentBondClient, type Wallet } from '../packages/sdk/src/index.ts';
import { DEVNET_PROFILE, NETWORK_GENESIS, resolveNetworkProfile, networkProfileFromEnv, assertNetworkGenesis, verifyNetworkGenesis, assertFaucetAllowed, explorerUrl } from '../packages/shared/src/network.ts';
import { encodedJob } from './protocol/sdk-job-fixture.ts';

const key = (byte:number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const local = { network:'localnet', rpcUrl:'http://127.0.0.1:8899', genesisHash:key(8), programId:key(3), mint:key(4), verifier:key(5), decimals:6 };
const mainnet = { ...local, network:'mainnet-beta', rpcUrl:'https://api.mainnet-beta.solana.com', genesisHash:NETWORK_GENESIS['mainnet-beta'], enableMainnet:true };

describe('strict network profiles', () => {
  it('pins the deployed devnet identities and freezes the resolved config', () => {
    const profile=resolveNetworkProfile({network:'devnet'});
    expect(profile).toEqual(DEVNET_PROFILE); expect(Object.isFrozen(profile)).toBe(true);
    expect(networkProfileFromEnv({AGENTBOND_NETWORK:'devnet'})).toEqual(profile);
  });
  it.each(['genesisHash','programId','mint','verifier','decimals'] as const)('rejects devnet %s substitution', field => {
    expect(()=>resolveNetworkProfile({network:'devnet',[field]:field==='decimals'?9:key(9)})).toThrow(/Devnet/);
  });
  it('requires an explicit network selection', () => {
    expect(()=>networkProfileFromEnv({})).toThrow(/AGENTBOND_NETWORK/);
    expect(()=>resolveNetworkProfile({network:'testnet'})).toThrow(/Unsupported/);
  });
  it('allows explicit isolated localnet and rejects a mislabeled public genesis', () => {
    expect(resolveNetworkProfile(local).network).toBe('localnet');
    for(const genesisHash of Object.values(NETWORK_GENESIS)) expect(()=>resolveNetworkProfile({...local,genesisHash})).toThrow(/Genesis/);
    expect(()=>resolveNetworkProfile({...local,rpcUrl:'https://example.com'})).toThrow(/loopback/);
    expect(()=>resolveNetworkProfile({network:'localnet'})).toThrow(/required/);
  });
  it('requires mainnet enable and all its own explicit settings', () => {
    expect(()=>resolveNetworkProfile({...mainnet,enableMainnet:false})).toThrow(/disabled/);
    expect(()=>resolveNetworkProfile({network:'mainnet-beta',enableMainnet:true})).toThrow(/required/);
    for(const field of ['programId','mint','verifier','rpcUrl','genesisHash','decimals'] as const) {
      expect(()=>resolveNetworkProfile({...mainnet,[field]:undefined})).toThrow();
    }
    for(const field of ['programId','mint','verifier'] as const) expect(()=>resolveNetworkProfile({...mainnet,[field]:DEVNET_PROFILE[field]})).toThrow(/devnet identities/);
    expect(()=>resolveNetworkProfile({...mainnet,mint:DEVNET_PROFILE.programId})).toThrow(/devnet identities/);
    expect(()=>resolveNetworkProfile({...mainnet,genesisHash:NETWORK_GENESIS.devnet})).toThrow(/Genesis/);
  });
  it('keeps faucets disabled even when mainnet is explicitly configured', () => {
    const profile=resolveNetworkProfile(mainnet);
    expect(profile.faucetEnabled).toBe(false); expect(()=>assertFaucetAllowed(profile)).toThrow(/disabled/);
    expect(()=>assertFaucetAllowed({...profile,faucetEnabled:true})).toThrow(/disabled/);
    expect(()=>assertFaucetAllowed(DEVNET_PROFILE)).not.toThrow();
  });
  it('rejects ambiguous enable/decimals environment values', () => {
    expect(()=>networkProfileFromEnv({AGENTBOND_NETWORK:'devnet',AGENTBOND_ENABLE_MAINNET:'1'})).toThrow(/true or false/);
    expect(()=>networkProfileFromEnv({AGENTBOND_NETWORK:'devnet',AGENTBOND_DECIMALS:''})).toThrow(/DECIMALS/);
    expect(()=>resolveNetworkProfile({...local,decimals:1.5})).toThrow(/decimals/);
  });
  it.each(['http://api.devnet.solana.com','https://localhost:8899','https://user:secret@example.com','https://example.com?key=secret','https://example.com#fragment'])('rejects unsafe public RPC %s', rpcUrl => {
    expect(()=>resolveNetworkProfile({network:'devnet',rpcUrl})).toThrow();
  });
  it('checks full genesis, rejecting a prefix and another network', async () => {
    expect(()=>assertNetworkGenesis(DEVNET_PROFILE,NETWORK_GENESIS.devnet.slice(0,32))).toThrow(/mismatch/);
    await expect(verifyNetworkGenesis(DEVNET_PROFILE,{getGenesisHash:async()=>NETWORK_GENESIS['mainnet-beta']})).rejects.toThrow(/mismatch/);
    await expect(verifyNetworkGenesis(DEVNET_PROFILE,{getGenesisHash:async()=>NETWORK_GENESIS.devnet})).resolves.toBeUndefined();
  });
  it('builds network-aware links without devnet suffix on mainnet', () => {
    expect(explorerUrl(DEVNET_PROFILE,key(3))).toContain('?cluster=devnet');
    expect(explorerUrl(resolveNetworkProfile(local),key(3),'tx')).toContain('?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899');
    expect(explorerUrl(resolveNetworkProfile(mainnet),key(3))).toBe(`https://explorer.solana.com/address/${key(3)}`);
    expect(()=>explorerUrl(DEVNET_PROFILE,'bad?cluster=mainnet')).toThrow(/identifier/);
  });
});

function fixture(genesis:string=NETWORK_GENESIS.devnet) {
  const getGenesisHash=vi.fn(async()=>genesis);
  const wallet:Wallet={publicKey:new PublicKey(key(7)),signTransaction:vi.fn(async tx=>tx),signAllTransactions:vi.fn(async txs=>txs)};
  const client=new AgentBondClient({getGenesisHash} as unknown as Connection,wallet,undefined,{networkProfile:DEVNET_PROFILE});
  return {client,wallet,getGenesisHash};
}
describe('SDK opt-in wallet guards', () => {
  it('rejects a mismatched genesis before fetching a job or requesting a signature', async () => {
    const {client,wallet}=fixture(NETWORK_GENESIS['mainnet-beta']);
    const fetch=vi.spyOn(client.program.account.job,'fetch');
    await expect(client.claimJob(key(3))).rejects.toThrow(/mismatch/);
    expect(fetch).not.toHaveBeenCalled(); expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('guards every custody and verifier mutation before a network mismatch can reach signing', async () => {
    const {client,wallet}=fixture(NETWORK_GENESIS['mainnet-beta']); const job=key(3),destination=key(4),hash='0'.repeat(64);
    const calls=[()=>client.fundJob(job,destination),()=>client.submitWork(job,hash),()=>client.approveWork(job,hash),()=>client.rejectWork(job,hash),()=>client.settleJob(job,destination),()=>client.refundJob(job,destination),()=>client.cancelJob(job),()=>client.settleJobToWorker(job)];
    for(const call of calls) await expect(call()).rejects.toThrow(/mismatch/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('rechecks the RPC at actual signing time rather than trusting an earlier verdict', async () => {
    const {client,wallet,getGenesisHash}=fixture();
    await client.assertNetwork(); getGenesisHash.mockResolvedValue(NETWORK_GENESIS['mainnet-beta']);
    await expect(client.provider.wallet.signTransaction(new Transaction())).rejects.toThrow(/mismatch/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    await expect(client.provider.wallet.signAllTransactions([new Transaction()])).rejects.toThrow(/mismatch/);
    expect(wallet.signAllTransactions).not.toHaveBeenCalled();
  });
  it.each(['mint','verifier','tokenProgram'] as const)('rejects a substituted job %s before constructing a mutation', async field => {
    const {client,wallet}=fixture();
    const authentic=await encodedJob(client,{[field]:new PublicKey(key(9))});
    Object.assign(client.connection,{getAccountInfo:vi.fn(async()=>authentic.info)});
    await expect(client.claimJob(authentic.address)).rejects.toThrow(/supported/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('rejects unsupported create identities before any mint lookup or signing', async () => {
    const {client,wallet}=fixture();
    await expect(client.createJob({id:'1',amount:'1',mint:new PublicKey(key(9)),verifier:new PublicKey(DEVNET_PROFILE.verifier),specHash:'0'.repeat(64),acceptanceHash:'1'.repeat(64),claimDeadline:1,submitDeadline:2,verifyDeadline:3})).rejects.toThrow(/supported/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it.each([{decimals:9,frozen:false},{decimals:6,frozen:true}])('refuses incompatible mint properties before requesting a signature: %j', async properties => {
    const {client,wallet}=fixture();
    const bytes=Buffer.alloc(MintLayout.span);
    MintLayout.encode({mintAuthorityOption:1,mintAuthority:new PublicKey(key(8)),supply:0n,decimals:properties.decimals,isInitialized:true,freezeAuthorityOption:properties.frozen?1:0,freezeAuthority:new PublicKey(key(9))},bytes);
    Object.assign(client.connection,{getAccountInfo:vi.fn(async()=>({data:bytes,owner:TOKEN_PROGRAM_ID,lamports:1,executable:false,rentEpoch:0}))});
    await expect(client.createJob({id:'1',amount:'1',mint:new PublicKey(DEVNET_PROFILE.mint),verifier:new PublicKey(DEVNET_PROFILE.verifier),specHash:'0'.repeat(64),acceptanceHash:'1'.repeat(64),claimDeadline:1,submitDeadline:2,verifyDeadline:3})).rejects.toThrow(/decimals or freeze authority/);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('derives the assigned worker destination rather than the caller wallet', async () => {
    const {client,wallet}=fixture(),mint=new PublicKey(DEVNET_PROFILE.mint);
    const actualWorker=new PublicKey('2rZn66HSqiZ4hmYxosiLD4uH1va4vW37KWDuc5WNPQyw');
    const authentic=await encodedJob(client,{worker:actualWorker,mint});
    Object.assign(client.connection,{getAccountInfo:vi.fn(async()=>authentic.info)});
    const destination=await client.workerTokenAddress(authentic.address);
    expect(destination.equals(await getAssociatedTokenAddress(mint,actualWorker))).toBe(true);
    expect(wallet.signTransaction).not.toHaveBeenCalled(); expect(actualWorker.equals(wallet.publicKey)).toBe(false);
  });
  it('builds one settlement transaction with idempotent worker ATA creation, paid by caller', async () => {
    const {client,wallet}=fixture(),mint=new PublicKey(DEVNET_PROFILE.mint),worker=new PublicKey('2rZn66HSqiZ4hmYxosiLD4uH1va4vW37KWDuc5WNPQyw');
    const authentic=await encodedJob(client,{worker,mint});
    Object.assign(client.connection,{getAccountInfo:vi.fn(async()=>authentic.info)});
    let captured:Transaction|undefined;
    vi.spyOn(client.provider,'sendAndConfirm').mockImplementation(async transaction=>{if (!(transaction instanceof Transaction)) throw new Error('Expected legacy settlement transaction');captured=transaction;return 'offline-instruction-build';});
    await expect(client.settleJobToWorker(authentic.address)).resolves.toBe('offline-instruction-build');
    expect(captured!.instructions).toHaveLength(2);
    const [ata,settle]=captured!.instructions,destination=await getAssociatedTokenAddress(mint,worker);
    expect(ata.data[0]).toBe(1); // Idempotent create opcode.
    expect(ata.keys[0].pubkey.equals(wallet.publicKey)).toBe(true);
    expect(ata.keys[1].pubkey.equals(destination)).toBe(true);
    expect(ata.keys[2].pubkey.equals(worker)).toBe(true);
    const definition=client.program.idl.instructions.find(value=>value.name==='settleJob')!;
    const destinationIndex=definition.accounts.findIndex(account=>account.name==='destination');
    expect(settle.keys[destinationIndex].pubkey.equals(destination)).toBe(true);
    expect(wallet.signTransaction).not.toHaveBeenCalled(); // Instructions inspected offline; no transaction sent.
  });
});
