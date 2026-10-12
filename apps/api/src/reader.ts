import { Connection, PublicKey } from '@solana/web3.js';
import type { BorshInstructionCoder } from '@coral-xyz/anchor';
import { AgentBondClient, type Wallet } from '../../../packages/sdk/src/index.ts';
import type { ChainReader, ChainEvent } from './indexer.ts';

export function createChainReader(connection: Connection, programId: PublicKey, options:{finalizedCacheSize?:number}={}): ChainReader {
  const wallet: Wallet = {
    publicKey: PublicKey.default,
    signTransaction: async () => { throw new Error('Read-only API has no wallet signing authority'); },
    signAllTransactions: async () => { throw new Error('Read-only API has no wallet signing authority'); },
  };
  const sdk = new AgentBondClient(connection, wallet, programId);
  const jobIndexes=new Map<string,number>(sdk.program.idl.instructions.map(instruction=>[instruction.name,instruction.accounts.findIndex(account=>account.name==='job')]));
  const limit=options.finalizedCacheSize ?? 1024;
  if(!Number.isInteger(limit)||limit<1||limit>5000)throw new Error('Finalized transaction cache must be bounded from 1 to 5000');
  type Decoded={actions:Map<string,string>;cacheable:boolean;failed:boolean};
  const finalized=new Map<string,Decoded>(),flights=new Map<string,Promise<Decoded>>();
  const decode=async(signature:string,isFinalized:boolean):Promise<Decoded>=>{
    const cached=finalized.get(signature);if(cached){finalized.delete(signature);finalized.set(signature,cached);return cached;}
    let pending=flights.get(signature);
    if(!pending){pending=(async()=>{
      const tx=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
      const actions=new Map<string,string>();
      if(tx&&tx.meta&&!tx.meta.err){
        const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});
        for(const ix of tx.transaction.message.compiledInstructions){
          if(!keys.get(ix.programIdIndex)?.equals(programId))continue;
          const action=(sdk.program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data))?.name;
          const jobIndex=action===undefined?undefined:jobIndexes.get(action);
          // Remaining accounts and other instruction participants cannot borrow
          // another job's lifecycle action. Bind only the IDL's named job slot.
          if(action&&jobIndex!==undefined&&jobIndex>=0){const accountIndex=ix.accountKeyIndexes[jobIndex],address=accountIndex===undefined?undefined:keys.get(accountIndex)?.toBase58();if(address)actions.set(address,action);}
        }
      }
      return {actions,cacheable:!!tx&&!!tx.meta&&!tx.meta.err,failed:!!tx?.meta?.err};
    })();flights.set(signature,pending);void pending.finally(()=>flights.delete(signature)).catch(()=>{});}
    const result=await pending;
    if(isFinalized&&result.cacheable){finalized.set(signature,result);while(finalized.size>limit)finalized.delete(finalized.keys().next().value!);}
    return result;
  };
  return {
    listJobs: () => sdk.listJobs(), getJob: address => sdk.getJob(address),
    async events(address) {
      const signatures = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 100 }, 'confirmed');
      const events: ChainEvent[] = [];
      for (const entry of signatures) {
        if (entry.err) continue;
        const decoded=await decode(entry.signature,entry.confirmationStatus==='finalized');
        if(decoded.failed)continue;
        events.push({ signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime ?? null, confirmationStatus: entry.confirmationStatus ?? null, action: decoded.actions.get(address) });
      }
      return events;
    },
  };
}
