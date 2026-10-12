import { describe,expect,it,vi } from 'vitest';
import { Connection, PublicKey, SystemProgram, type AccountChangeCallback } from '@solana/web3.js';
import { AgentBondClient, type Wallet } from '../../packages/sdk/src/index.ts';
import { encodedJob } from './sdk-job-fixture.ts';

const wallet:Wallet={publicKey:PublicKey.default,signTransaction:vi.fn(async tx=>tx),signAllTransactions:vi.fn(async txs=>txs)};
function fixture() {
  const rpc={getAccountInfo:vi.fn(),onAccountChange:vi.fn(),removeAccountChangeListener:vi.fn(async()=>{})};
  return {rpc,client:new AgentBondClient(rpc as unknown as Connection,wallet)};
}
describe('authoritative SDK account integrity',()=>{
  it('reads and validates one owned canonical Borsh account from one RPC response',async()=>{
    const {rpc,client}=fixture(),authentic=await encodedJob(client);rpc.getAccountInfo.mockResolvedValue(authentic.info);
    const job=await client.getJob(authentic.address);
    expect(job?.address).toBe(authentic.address.toBase58());expect(job?.status).toBe('SETTLED');
    expect(rpc.getAccountInfo).toHaveBeenCalledExactlyOnceWith(authentic.address,'confirmed');
  });
  it('rejects copied authentic discriminator/data owned by another program on every direct read path',async()=>{
    const {rpc,client}=fixture(),authentic=await encodedJob(client);rpc.getAccountInfo.mockResolvedValue({...authentic.info,owner:SystemProgram.programId});
    await expect(client.getJob(authentic.address)).rejects.toThrow(/owner/);
    await expect(client.workerTokenAddress(authentic.address)).rejects.toThrow(/owner/);
    await expect(client.fundJob(authentic.address,PublicKey.unique())).rejects.toThrow(/owner/);
    expect(rpc.getAccountInfo).toHaveBeenCalledTimes(3);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('rejects otherwise valid program-owned bytes at a noncanonical address',async()=>{
    const {rpc,client}=fixture(),authentic=await encodedJob(client);rpc.getAccountInfo.mockResolvedValue(authentic.info);
    await expect(client.getJob(PublicKey.unique())).rejects.toThrow(/canonical creator\/id PDA/);
  });
  it('rejects a substituted vault and both corrupted PDA bumps',async()=>{
    const {rpc,client}=fixture(),authentic=await encodedJob(client);
    for(const overrides of [{vault:PublicKey.unique()},{bump:authentic.data.bump^255},{vaultBump:authentic.data.vaultBump^255}]) {
      const altered=await encodedJob(client,overrides);rpc.getAccountInfo.mockResolvedValue(altered.info);
      await expect(client.getJob(altered.address)).rejects.toThrow(/canonical/);
    }
  });
  it('returns null only for an actually absent account and fails closed on RPC failure',async()=>{
    const {rpc,client}=fixture();rpc.getAccountInfo.mockResolvedValue(null);
    expect(await client.getJob(PublicKey.unique())).toBeNull();rpc.getAccountInfo.mockRejectedValue(Error('RPC unavailable'));
    await expect(client.getJob(PublicKey.unique())).rejects.toThrow('RPC unavailable');
  });
  it('validates canonical identity of owner-filtered list results',async()=>{
    const {client}=fixture(),authentic=await encodedJob(client);
    const scan=vi.spyOn(client.program.account.job,'all');scan.mockResolvedValue([{publicKey:authentic.address,account:authentic.data}]);
    expect((await client.listJobs())[0].address).toBe(authentic.address.toBase58());
    scan.mockResolvedValue([{publicKey:PublicKey.unique(),account:authentic.data}]);await expect(client.listJobs()).rejects.toThrow(/canonical creator\/id/);
    scan.mockResolvedValue([{publicKey:authentic.address,account:{...authentic.data,vault:PublicKey.unique()}}]);await expect(client.listJobs()).rejects.toThrow(/vault/);
  });
  it('emits only valid same-response owner/identity subscription updates, without another RPC read',async()=>{
    const {rpc,client}=fixture(),authentic=await encodedJob(client),callback=vi.fn();
    let listener!:AccountChangeCallback;rpc.onAccountChange.mockImplementation((_address,cb)=>{listener=cb;return 7;});
    const unsubscribe=client.watchJob(authentic.address,callback);
    listener({...authentic.info,owner:SystemProgram.programId},{slot:1});expect(callback).not.toHaveBeenCalled();
    const wrong=await encodedJob(client,{vault:PublicKey.unique()});listener(wrong.info,{slot:2});expect(callback).not.toHaveBeenCalled();
    listener(authentic.info,{slot:3});expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({address:authentic.address.toBase58(),status:'SETTLED'}));
    expect(rpc.getAccountInfo).not.toHaveBeenCalled();await unsubscribe();expect(rpc.removeAccountChangeListener).toHaveBeenCalledWith(7);
  });
});
