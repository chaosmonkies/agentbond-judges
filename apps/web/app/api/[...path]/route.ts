import {NextRequest,NextResponse} from 'next/server';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {AgentBondClient,type Wallet} from '../../../../../packages/sdk/src/index';
import publicData from '../../../data/public.json';
import {proxyBackend} from '../../../lib/proxy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Metadata={address?:string;title?:string;spec?:unknown};
type PublicData={config:null|{programId:string;mint:string;network:string;rpcUrl:string;decimals?:number};jobs:Record<string,Metadata>;agents:Array<{id:string;wallet:string;[key:string]:unknown}>;artifacts:Record<string,{artifact?:string;receipt?:string}>;inputs:Record<string,string>};
const data=publicData as PublicData;
class EvidenceError extends Error { constructor(readonly status:number,message:string){super(message)} }
const evidenceHash=(raw:string)=>createHash('sha256').update(raw,'utf8').digest('hex');
function validateEvidence(raw:string,committedHash:string){if(Buffer.byteLength(raw,'utf8')>2*1024*1024)throw new EvidenceError(413,'Artifact limit');const hash=evidenceHash(raw);if(hash!==committedHash)throw new EvidenceError(409,'Artifact differs from chain commitment');return hash}
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function GET(request:NextRequest,context:{params:Promise<{path:string[]}>}){
 if(process.env.AGENTBOND_BACKEND_URL){const path=(await context.params).path;const upstream=await proxyBackend(request,path,process.env.AGENTBOND_BACKEND_URL,process.env.AGENTBOND_INTERNAL_BACKEND_HOST);if(upstream.status===404&&path.length===2&&path[0]==='inputs'&&path[1]==='demo.csv'&&data.inputs['demo.csv']!==undefined)return new NextResponse(data.inputs['demo.csv'],{headers:{'Content-Type':'text/csv','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});return upstream;}
 try{
  const path=(await context.params).path;
  if(!data.config)return response({error:'Public chain configuration has not been deployed.'},503);
  const config={...data.config,rpcUrl:process.env.AGENTBOND_PUBLIC_RPC_URL??data.config.rpcUrl};
  if(path[0]==='config')return response({...config,metadataWrites:false,authority:'Solana RPC',tokenName:'AgentBond Demo USD'});
  if(path[0]==='inputs'){const input=data.inputs[path.slice(1).join('/')];if(input===undefined)return response({error:'Input not found'},404);return new NextResponse(input,{headers:{'Content-Type':'text/csv','Cache-Control':'no-store'}})}
  if(path[0]==='agents'){const agent=path[1]?data.agents.find(a=>a.id===path[1]):null;if(path[1])return agent?response({agent}):response({error:'Agent not found'},404);return response({agents:data.agents,authority:'signed metadata packaged at deployment'})}
  const connection=new Connection(config.rpcUrl,'confirmed');
  const readWallet={publicKey:PublicKey.default,signTransaction:async()=>{throw new Error('Public API never signs transactions')},signAllTransactions:async()=>{throw new Error('Public API never signs transactions')}} as Wallet;
  const sdk=new AgentBondClient(connection,readWallet,new PublicKey(config.programId));
  if(path[0]==='health'){await connection.getLatestBlockhash();return response({ok:true,chainAuthority:'Solana RPC',metadataWrites:false})}
  if(path[0]==='jobs'&&!path[1]){const jobs=await sdk.listJobs();return response({jobs:jobs.map(j=>({...j,metadata:data.jobs[j.address]})),authority:'chain'})}
  if(path[0]==='stats'){const jobs=await sdk.listJobs();const byStatus:Record<string,number>={};jobs.forEach(j=>byStatus[j.status]=(byStatus[j.status]??0)+1);return response({totalJobs:jobs.length,settledJobs:byStatus.SETTLED??0,fundedJobs:jobs.filter(j=>['FUNDED','CLAIMED','SUBMITTED','VERIFIED'].includes(j.status)).length,registeredAgents:data.agents.length,byStatus,authority:'chain'})}
  if(path[0]==='jobs'&&path[1]){const address=new PublicKey(path[1]),job=await sdk.getJob(address);if(!job)return response({error:'Job not found'},404);if(path[2]==='events'){const events=(await connection.getSignaturesForAddress(address,{limit:30})).map(e=>({signature:e.signature,slot:e.slot,blockTime:e.blockTime,confirmationStatus:e.confirmationStatus,action:e.err?'Failed onchain transaction':'Confirmed onchain transaction',err:e.err}));return response({events})}if(path[2]==='artifacts'){const evidence=data.artifacts[job.address];const rawType=request.nextUrl.searchParams.get('raw');if(rawType){if(rawType!=='artifact'&&rawType!=='receipt')return response({error:'Unknown raw evidence type'},400);const raw=evidence?.[rawType];if(raw===undefined)return response({error:'Evidence not published'},404);validateEvidence(raw,rawType==='artifact'?job.artifactHash:job.verificationHash);return new NextResponse(raw,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}const item=(raw:string|undefined,committedHash:string)=>{if(raw===undefined)return null;const hash=validateEvidence(raw,committedHash);return {hash,committedHash,matchesChainCommitment:true,content:JSON.parse(raw)}};return response({artifact:item(evidence?.artifact,job.artifactHash),receipt:item(evidence?.receipt,job.verificationHash)})}return response({job,metadata:data.jobs[job.address],authority:'chain'})}
  return response({error:'Route not found'},404);
 }catch(error){return response({error:error instanceof Error?error.message:String(error)},error instanceof EvidenceError?error.status:503)}
}
export async function POST(request:NextRequest,context:{params:Promise<{path:string[]}>}){if(process.env.AGENTBOND_BACKEND_URL)return proxyBackend(request,(await context.params).path,process.env.AGENTBOND_BACKEND_URL,process.env.AGENTBOND_INTERNAL_BACKEND_HOST);return response({error:'This public deployment serves live chain reads and packaged evidence. Metadata registration requires a persistent authenticated backend; public job creation is disabled until that service is configured.'},405)}
