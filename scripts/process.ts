import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, mkdirSync, closeSync } from 'node:fs';
import { Connection } from '@solana/web3.js';

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function rpcReady(url: string) {
  try { const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getVersion'}),signal:AbortSignal.timeout(5000)}); const value=await response.json(); return response.ok&&typeof value.result?.['solana-core']==='string'; } catch { return false; }
}
export async function waitFor(check: () => Promise<boolean>, milliseconds = 30000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { if (await check()) return; await pause(500); }
  throw new Error(`Readiness timeout after ${milliseconds}ms`);
}
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
export function loggedProcess(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  mkdirSync('.orchestrator/logs', { recursive: true });
  const fd = openSync(`.orchestrator/logs/${name}.log`, 'a', 0o600);
  const child = spawn(command, args, { stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  child.on('error', error => console.error(`${name}: ${error.message}`));
  return child;
}
