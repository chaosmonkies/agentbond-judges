import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '../../shared/src/index.ts';

export async function registerHostedProfile(apiUrl: string, domain: string, role: 'worker'|'verifier', key: Keypair) {
  const api = new URL(apiUrl);
  if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || api.username || api.password || api.search || api.hash) throw new Error('Agent registration requires the internal literal loopback API');
  const base=api.href.replace(/\/$/,'');
  const profile = {id:role==='worker'?'csv-worker':'independent-verifier',wallet:key.publicKey.toBase58(),capabilities:role==='worker'?['csv-analysis','bounded deterministic CSV execution']:['csv-analysis','designated verifier; independent recomputation'],taskTypes:['csv-analysis'],maxRuntimeMs:2000};
  const raw=JSON.stringify(profile), bodyHash=sha256(raw);
  const response=await fetch(base+'/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:profile.wallet,action:'register-agent',bodyHash}),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`Registration challenge failed: ${response.status}`);
  const challenge=await response.json() as {nonce:string;message:string;domain:string;expiresAt:number};
  const lines=typeof challenge.message==='string'?challenge.message.split('\n'):[];
  if (challenge.domain!==domain || !/^[0-9a-f]{64}$/.test(challenge.nonce) || challenge.expiresAt<=Date.now() || challenge.expiresAt>Date.now()+60000 || lines.length!==8 || lines[0]!=='AgentBond wallet authorization' || lines[1]!==`Domain: ${domain}` || lines[2]!==`Wallet: ${profile.wallet}` || lines[3]!=='Action: register-agent' || lines[4]!==`Body SHA256: ${bodyHash}` || lines[5]!==`Nonce: ${challenge.nonce}` || lines[7]!==`Expires at: ${new Date(challenge.expiresAt).toISOString()}` || !/^Issued at: \d{4}-/.test(lines[6])) throw new Error('Registration challenge did not match the requested signature scope');
  const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),key.secretKey)).toString('base64');
  const authorization='AgentBond '+Buffer.from(JSON.stringify({wallet:profile.wallet,nonce:challenge.nonce,signature})).toString('base64');
  const result=await fetch(base+'/agents/register',{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body:raw,signal:AbortSignal.timeout(10000)});
  if (!result.ok) throw new Error(`Signed registration failed: ${result.status}`);
  return profile;
}
