import { Connection } from '@solana/web3.js';

const MIN_START_INTERVAL_MS=1100;
const NETWORK_TIMEOUT_MS=15000;
const MAX_RETRY_AFTER_MS=10000;
// One process-wide budget, including every Connection returned by this module.
let lastStart:number|null=null;
let notBefore=0,blockedUntil=0;
let queue:Promise<void>=Promise.resolve();

function sleep(ms:number,signal?:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
function reserveStart(signal?:AbortSignal):Promise<void> {
  const slot=queue.then(async()=>{
    if(signal?.aborted)throw signal.reason;
    while(true){
      if(Date.now()<blockedUntil)throw new Error('RPC server Retry-After cooldown exceeds the verification wait bound');
      const wait=Math.max(0,notBefore-Date.now(),lastStart===null?0:lastStart+MIN_START_INTERVAL_MS-Date.now());
      if(wait===0)break;
      await sleep(wait,signal);
    }
    if(signal?.aborted)throw signal.reason;
    lastStart=Date.now();
  });
  queue=slot.catch(()=>{});
  return slot;
}
function retryDelay(header:string|null,attempt:number):number|null {
  const base=attempt===0?2000:4000;
  if(header===null)return base;
  const seconds=/^\d+(?:\.\d+)?$/.test(header.trim())?Number(header):NaN;
  const parsed=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now();
  if(!Number.isFinite(parsed)||parsed<0)return base;
  // Never retry sooner than a valid server cooldown: stop if it exceeds our bound.
  if(parsed>MAX_RETRY_AFTER_MS){blockedUntil=Math.max(blockedUntil,Date.now()+parsed);return null;}
  return Math.max(base,parsed);
}
async function validateRead(input:Parameters<typeof fetch>[0],init?:RequestInit):Promise<void> {
  const request=input instanceof Request?input:undefined;
  if((init?.method??request?.method??'GET').toUpperCase()!=='POST')throw new Error('Read-only Solana RPC requires a JSON POST');
  if(init?.body!==undefined&&typeof init.body!=='string')throw new Error('Read-only RPC requires a JSON string body');
  const raw=typeof init?.body==='string'?init.body:request?await request.clone().text():undefined;
  if(raw===undefined||raw.length>65536)throw new Error('Read-only RPC request body is missing or exceeds limit');
  let body:unknown;try{body=JSON.parse(raw);}catch{throw new Error('Read-only RPC requires valid JSON');}
  const requests=Array.isArray(body)?body:[body];
  if(!requests.length||requests.length>100)throw new Error('Read-only RPC batch exceeds limit');
  for(const item of requests){
    const method=item&&typeof item==='object'?(item as {method?:unknown}).method:undefined;
    if(typeof method!=='string'||!(/^get[A-Za-z0-9_]+$/.test(method)||method==='isBlockhashValid'))throw new Error('Write or unsupported RPC method refused before transport');
  }
}
async function readOnlyFetch(input:Parameters<typeof fetch>[0],init?:RequestInit):Promise<Response> {
  await validateRead(input,init);
  const callerSignal=init?.signal??(input instanceof Request?input.signal:undefined)??undefined;
  for(let attempt=0;attempt<=2;attempt++){
    await reserveStart(callerSignal);
    const timeout=AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    const signal=callerSignal?AbortSignal.any([callerSignal,timeout]):timeout;
    const response=await fetch(input instanceof Request?input.clone():input,{...init,signal});
    if(response.status!==429)return response;
    const delay=retryDelay(response.headers.get('retry-after'),Math.min(attempt,1));
    if(delay!==null)notBefore=Math.max(notBefore,Date.now()+delay);
    if(delay===null||attempt===2)return response;
    await response.body?.cancel();
    await sleep(delay,callerSignal);
  }
  throw new Error('Read-only RPC retry limit exceeded');
}
export function createReadOnlyRpcConnection(url:string):Connection {
  return new Connection(url,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:readOnlyFetch});
}
