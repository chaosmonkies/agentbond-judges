import { it,expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRuntimeConnection } from '../../packages/agent-runtime/src/rpc.ts';

it('shares two persistent HTTP sockets across RPC connections instead of opening one per request',async()=>{
 let active=0,peak=0,sockets=0,requests=0;
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks).toString());active++;peak=Math.max(peak,active);requests++;await new Promise(resolve=>setTimeout(resolve,25));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'}));active--;});
 server.on('connection',()=>sockets++);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`,connections=[createRuntimeConnection(url),createRuntimeConnection(url)];const hashes=await Promise.all(Array.from({length:10},(_,i)=>connections[i%2].getGenesisHash()));expect(hashes).toHaveLength(10);expect(requests).toBe(10);expect(peak).toBeLessThanOrEqual(2);expect(sockets).toBeLessThanOrEqual(2);}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
