import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Connection, PublicKey } from '@solana/web3.js';
import { createChainReader } from '../apps/api/src/reader.ts';
import { sha256 } from '../packages/shared/src/index.ts';
import { CSV } from './inputs.ts';
const manifest=JSON.parse(await readFile('artifacts/demo-devnet.json','utf8'));
assert.equal(manifest.network,'devnet');
const connection=new Connection('https://api.devnet.solana.com','confirmed');
assert.equal(await connection.getGenesisHash(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const reader=createChainReader(connection,new PublicKey(manifest.programId));
const data={config:{programId:manifest.programId,mint:manifest.mint,network:'devnet',rpcUrl:'https://api.devnet.solana.com',decimals:6},jobs:{} as Record<string,unknown>,agents:manifest.agents,artifacts:{} as Record<string,unknown>,inputs:{'demo.csv':CSV.toString()}};
for(const item of manifest.jobs){const chain=await reader.getJob(item.address);assert(chain&&['SETTLED','REFUNDED'].includes(chain.status));const artifact=await readFile(item.artifactPath,'utf8'),receipt=await readFile(item.receiptPath,'utf8');assert.equal(sha256(artifact),chain.artifactHash);assert.equal(sha256(receipt),chain.verificationHash);data.jobs[item.address]={address:item.address,title:item.title,spec:item.spec};data.artifacts[item.address]={artifact,receipt};}
await writeFile('apps/web/data/public.json',JSON.stringify(data,null,2));
console.log('Public devnet evidence independently verified and packaged');
