import type { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '../packages/shared/src/index.ts';
import { validateChallenge, type AuthAction } from '../packages/shared/src/wallet-auth.ts';

export async function authorizedHostedPost(origin:string,key:Keypair,action:AuthAction,path:string,raw:string|Uint8Array,contentType='application/json') {
  const request=await fetch(origin+'/api/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:key.publicKey.toBase58(),action,bodyHash:sha256(raw)}),signal:AbortSignal.timeout(15000)});
  if(!request.ok)throw new Error(`Challenge rejected: HTTP${request.status}`);
  const challenge=await request.json();validateChallenge(challenge,{domain:new URL(origin).host,wallet:key.publicKey.toBase58(),bodyHash:sha256(raw),action});
  const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),key.secretKey)).toString('base64');
  const authorization='AgentBond '+Buffer.from(JSON.stringify({wallet:key.publicKey.toBase58(),nonce:challenge.nonce,signature})).toString('base64');
  const response=await fetch(origin+'/api'+path,{method:'POST',headers:{'Content-Type':contentType,Authorization:authorization},body:raw as BodyInit,signal:AbortSignal.timeout(40000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP${response.status}`);return result;
}
