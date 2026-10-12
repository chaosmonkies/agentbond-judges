import { mkdir, stat, writeFile, chmod, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
export async function ensureKeys() {
  const dir = resolve(process.env.AGENTBOND_KEY_DIR ?? join(homedir(), '.agentbond', 'keys'));
  if (dir.startsWith(resolve('.') + '/') || dir===resolve('.')) throw new Error('Signing keys must stay outside the repository');
  await mkdir(dir,{recursive:true,mode:0o700});
  const canonical=await realpath(dir),repo=await realpath(resolve('.'));
  if(canonical===repo||canonical.startsWith(repo+'/')||canonical===homedir()||canonical==='/')throw new Error('Signing directory must be a dedicated directory outside the repository');
  await chmod(dir,0o700);
  for (const role of ['creator','worker','verifier','deployer']) {
    const path=join(dir,role+'.json');
    try { const existing=await stat(path); if ((existing.mode&0o077)!==0) throw new Error(`Restrict ${role} key permissions to0600`); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; const key=Keypair.generate(); await writeFile(path,JSON.stringify(Array.from(key.secretKey)),{mode:0o600,flag:'wx'}); }
  }
  return dir;
}
