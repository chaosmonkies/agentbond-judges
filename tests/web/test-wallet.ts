import type {Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {Keypair,Transaction} from '@solana/web3.js';
import nacl from 'tweetnacl';
// Only a signing transport: real transactions use the chain. Secret bytes stay in Node.
export async function realWallet(page:Page,path:string){
 const key=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path,'utf8'))));
 await page.exposeFunction('agentbondTestSign',async(raw:number[])=>{const tx=Transaction.from(Uint8Array.from(raw));tx.partialSign(key);return Array.from(tx.serialize())});
 await page.exposeFunction('agentbondTestMessage',async(raw:number[])=>Array.from(nacl.sign.detached(Uint8Array.from(raw),key.secretKey)));
 await page.addInitScript((publicKey)=>{const w=window as unknown as {solana:unknown;agentbondTestSign:(v:number[])=>Promise<number[]>;agentbondTestMessage:(v:number[])=>Promise<number[]>};const pk={toBase58:()=>publicKey};w.solana={publicKey:null,connect:async()=>({publicKey:pk}),signTransaction:async(tx:unknown)=>{const t=tx as {serialize:(opts:unknown)=>Uint8Array;constructor:{from:(v:Uint8Array)=>unknown}};return t.constructor.from(Uint8Array.from(await w.agentbondTestSign(Array.from(t.serialize({requireAllSignatures:false,verifySignatures:false})))));},signAllTransactions:async(txs:unknown[])=>Promise.all(txs.map(async tx=>{const t=tx as {serialize:(opts:unknown)=>Uint8Array;constructor:{from:(v:Uint8Array)=>unknown}};return t.constructor.from(Uint8Array.from(await w.agentbondTestSign(Array.from(t.serialize({requireAllSignatures:false,verifySignatures:false})))))})),signMessage:async(msg:Uint8Array)=>({signature:Uint8Array.from(await w.agentbondTestMessage(Array.from(msg)))})};},key.publicKey.toBase58());return key.publicKey.toBase58();
}
