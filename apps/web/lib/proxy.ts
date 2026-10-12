const LIMIT=2*1024*1024;
const allowedResponseHeaders=['content-type','cache-control','retry-after','x-content-type-options'];
class SizeLimit extends Error{}
async function readBounded(stream:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal){
 if(!stream)return new Uint8Array();const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{})};signal.addEventListener('abort',cancel,{once:true});
 try{while(true){if(signal.aborted)throw new Error('Request cancelled');const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>limit){await reader.cancel();throw new SizeLimit('Body too large')}chunks.push(result.value)}if(signal.aborted)throw new Error('Request cancelled');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes}finally{signal.removeEventListener('abort',cancel);reader.releaseLock()}
}
// The optional hostname comes only from server configuration, never request input.
export async function proxyBackend(request:Request,path:string[],backend:string,internalBackendHost?:string):Promise<Response>{
 try{
  const base=new URL(backend);
  const approvedInternal=!!internalBackendHost&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(internalBackendHost)&&base.hostname===internalBackendHost;
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&(['localhost','127.0.0.1','[::1]'].includes(base.hostname)||approvedInternal)))throw new Error('Backend URL must use HTTPS, loopback HTTP or an explicitly approved internal service.');
  if(base.username||base.password)throw new Error('Backend URL credentials are unsupported.');
  if(!path.length||path.some(segment=>segment==='.'||segment==='..'||/[\/\\]/.test(segment)))throw new Error('Invalid backend route');
  base.pathname=base.pathname.replace(/\/$/,'')+'/'+path.map(encodeURIComponent).join('/');base.search=new URL(request.url).search;base.hash='';
  const headers=new Headers();for(const name of ['authorization','content-type','accept','origin']){const value=request.headers.get(name);if(value)headers.set(name,value)}
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(30000)]);
  let body:Uint8Array|undefined;
  if(!['GET','HEAD'].includes(request.method)){if(Number(request.headers.get('content-length'))>LIMIT)return Response.json({error:'Request exceeds 2 MiB limit.'},{status:413});try{body=await readBounded(request.body,LIMIT,signal)}catch(error){if(error instanceof SizeLimit)return Response.json({error:'Request exceeds 2 MiB limit.'},{status:413});throw error}}
  const upstream=await fetch(base,{method:request.method,headers,body:body as BodyInit|undefined,redirect:'manual',signal,cache:'no-store'});
  // Never follow an upstream redirect with a wallet authorization header.
  if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel();return Response.json({error:'Backend redirect refused.'},{status:502})}
  if(upstream.headers.get('content-type')?.startsWith('text/event-stream')){await upstream.body?.cancel();return Response.json({error:'Streaming endpoint unsupported. Job status polling is available.'},{status:406})}
  const outputHeaders=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});for(const name of allowedResponseHeaders){const value=upstream.headers.get(name);if(value)outputHeaders.set(name,value)}
  try{const bytes=await readBounded(upstream.body,6*1024*1024,signal);return new Response(upstream.status===204||upstream.status===205||request.method==='HEAD'?null:bytes as BodyInit,{status:upstream.status,headers:outputHeaders})}catch(error){if(error instanceof SizeLimit)return Response.json({error:'Backend response exceeds the supported evidence limit.'},{status:502});throw error}
 }catch{return Response.json({error:'Hosted AgentBond backend is unavailable. Retry after checking service health.'},{status:502,headers:{'Cache-Control':'no-store'}})}
}
