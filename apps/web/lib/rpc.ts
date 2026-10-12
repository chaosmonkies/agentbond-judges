import {Connection} from '@solana/web3.js';
import type {Config} from './types';
import {resolveNetworkProfile} from '../../../packages/shared/src/network';
type Fetcher=typeof fetch;
/** One drained HTTP request at a time per browser profile; no RPC result cache. */
export class RpcTransport{
 private tail:Promise<void>=Promise.resolve();
 constructor(private readonly fetcher:Fetcher=globalThis.fetch.bind(globalThis),private readonly sleep:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))){}
 readonly fetch:Fetcher=(input,init)=>{const run=this.tail.then(()=>this.request(input,init));this.tail=run.then(()=>{},()=>{});return run};
 private async request(input:Parameters<Fetcher>[0],init?:Parameters<Fetcher>[1]){
  for(let attempt=0;;attempt++){
   const signals=[AbortSignal.timeout(15000),...(init?.signal?[init.signal]:[])];const signal=AbortSignal.any(signals);
   const response=await this.fetcher(input,{...init,signal});const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
   if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6*1024*1024){await reader.cancel();throw new Error('RPC response exceeds the supported limit.')}chunks.push(value)}}finally{reader.releaseLock()}}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
   const result=new Response(response.status===204?null:bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
   if(response.status!==429||attempt>=2)return result;
   const retry=response.headers.get('retry-after');const seconds=retry===null?NaN:Number(retry);const delay=Number.isFinite(seconds)&&seconds>=0?Math.min(12000,seconds*1000):2000*2**attempt;
   await this.sleep(delay);if(init?.signal?.aborted)throw new Error('RPC request cancelled.');
  }
 }
}
const connections=new Map<string,Connection>();
export function rpcIdentity(config:Config){const profile=['devnet','mainnet-beta'].includes(config.network)?resolveNetworkProfile({...config,verifier:config.designatedVerifier??config.defaultVerifier??config.verifier}):config;return JSON.stringify([profile.network,new URL(profile.rpcUrl).toString(),profile.programId,profile.mint,profile.decimals,profile.genesisHash,profile.enableMainnet,'verifier' in profile?profile.verifier:undefined])}
export function rpcConnection(config:Config){const identity=rpcIdentity(config);let connection=connections.get(identity);if(!connection){const transport=new RpcTransport();connection=new Connection(config.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:transport.fetch});connections.set(identity,connection)}return connection}
