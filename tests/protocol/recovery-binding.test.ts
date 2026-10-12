import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import BN from 'bn.js';
import { AgentBondClient, type Wallet } from '../../packages/sdk/src/index.ts';
import { recoverJobTransactions } from '../../packages/agent-runtime/src/chain-evidence.ts';

const readWallet:Wallet={publicKey:PublicKey.default,signTransaction:async()=>{throw new Error('Read-only test');},signAllTransactions:async()=>{throw new Error('Read-only test');}};
describe('recovered lifecycle instruction account binding',()=>{
  const sdk=new AgentBondClient({} as Connection,readWallet);
  const requested=PublicKey.unique(),other=PublicKey.unique();
  function fixture(action:string,bound:PublicKey,remaining:boolean) {
    const definition=sdk.program.idl.instructions.find(value=>value.name===action)!;
    const jobIndex=definition.accounts.findIndex(account=>account.name==='job');
    const accounts=definition.accounts.map((_,index)=>index===jobIndex?bound:PublicKey.unique());
    if(remaining)accounts.push(requested);
    const keys=[sdk.programId,...accounts];
    const hash=new Array(32).fill(0);
    const args=action==='createJob'?{id:new BN(1),amount:new BN(1),verifier:PublicKey.unique(),specHash:hash,acceptanceHash:hash,claimDeadline:new BN(1),submitDeadline:new BN(2),verifyDeadline:new BN(3)}:action==='submitWork'?{artifactHash:hash}:['approveWork','rejectWork'].includes(action)?{verificationHash:hash}:{};
    const tx={meta:{err:null},transaction:{message:{getAccountKeys:()=>({get:(index:number)=>keys[index]}),compiledInstructions:[{programIdIndex:0,accountKeyIndexes:accounts.map((_,index)=>index+1),data:sdk.program.coder.instruction.encode(action,args)}]}}} as unknown as VersionedTransactionResponse;
    const rpc={getSignaturesForAddress:vi.fn(async()=>[{signature:'actual-recorded-signature',slot:7,err:null,confirmationStatus:'finalized'}]),getTransaction:vi.fn(async()=>tx)} as unknown as Connection;
    return {rpc,tx};
  }
  it.each(['createJob','fundJob','claimJob','submitWork','approveWork','rejectWork','settleJob','refundJob','cancelJob'])('rejects %s for another job with requested job only as a remaining account',async action=>{
    const {rpc}=fixture(action,other,true);
    expect(await recoverJobTransactions(rpc,sdk,requested.toBase58(),signature=>'explorer/'+signature)).toEqual([]);
  });
  it.each([['createJob','create'],['fundJob','fund'],['claimJob','claim'],['submitWork','submit'],['approveWork','approve'],['rejectWork','reject'],['settleJob','settle'],['refundJob','refund'],['cancelJob','cancel']])('decodes %s only when its named job account matches',async(action,expected)=>{
    const {rpc}=fixture(action,requested,false);
    expect(await recoverJobTransactions(rpc,sdk,requested.toBase58(),signature=>'explorer/'+signature)).toEqual([{action:expected,signature:'actual-recorded-signature',slot:7,finality:'finalized',explorer:'explorer/actual-recorded-signature'}]);
  });
  it('preserves rejected submission labeling for the correct job',async()=>{
    const {rpc}=fixture('submitWork',requested,false);
    expect((await recoverJobTransactions(rpc,sdk,requested.toBase58(),signature=>signature,true))[0].action).toBe('submit-corrupt');
  });
});
