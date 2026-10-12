import { Connection } from '@solana/web3.js';
import { Agent, fetch as rpcFetch } from 'undici';
const dispatcher=new Agent({connections:2,keepAliveTimeout:60000,keepAliveMaxTimeout:60000,pipelining:1});
/** Every hosted RPC HTTP request has a deadline; rate-limit retries stay in service backoff. */
export function createRuntimeConnection(url: string) {
  return new Connection(url,{commitment:'confirmed',disableRetryOnRateLimit:true,confirmTransactionInitialTimeout:20000,
    fetch: (input,init) => rpcFetch(input as Parameters<typeof rpcFetch>[0], { ...init, dispatcher, signal: init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) } as Parameters<typeof rpcFetch>[1]) as unknown as ReturnType<typeof fetch>,
  });
}
