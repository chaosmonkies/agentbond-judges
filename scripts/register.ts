import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '../packages/shared/src/index.ts';

const manifest = JSON.parse(await readFile('artifacts/demo.json','utf8'));
const api = 'http://127.0.0.1:4100';
for (const profile of manifest.agents) {
  const role = profile.id === 'csv-worker' ? 'worker' : 'verifier';
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(process.env.AGENTBOND_KEY_DIR ?? join(homedir(),'.agentbond','keys'),role+'.json'),'utf8'))));
  if (signer.publicKey.toBase58() !== profile.wallet) throw new Error('Profile key mismatch');
  const body = JSON.stringify(profile);
  const response = await fetch(api+'/auth/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:profile.wallet,action:'register-agent',bodyHash:sha256(body)})});
  if (!response.ok) throw new Error('Challenge failed');
  const challenge = await response.json();
  const lines=typeof challenge.message==='string'?challenge.message.split('\n'):[];
  const expiry=Date.parse(lines[7]?.replace('Expires at: ',''));
  if (challenge.domain!=='localhost:3000'||lines.length!==8||lines[0]!=='AgentBond wallet authorization'||lines[1]!=='Domain: localhost:3000'||lines[2]!==`Wallet: ${profile.wallet}`||lines[3]!=='Action: register-agent'||lines[4]!==`Body SHA256: ${sha256(body)}`||lines[5]!==`Nonce: ${challenge.nonce}`||!/^[0-9a-f]{64}$/.test(challenge.nonce)||!Number.isFinite(expiry)||expiry!==challenge.expiresAt||expiry<=Date.now()||expiry>Date.now()+65000) throw new Error('Unexpected signing challenge');
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(challenge.message),signer.secretKey)).toString('base64');
  const authorization = 'AgentBond '+Buffer.from(JSON.stringify({wallet:profile.wallet,nonce:challenge.nonce,signature})).toString('base64');
  const registered = await fetch(api+'/agents/register',{method:'POST',headers:{'Content-Type':'application/json',Authorization:authorization},body});
  if (!registered.ok) throw new Error(await registered.text());
  console.log('Signed agent registration verified:',profile.id,profile.wallet);
}
