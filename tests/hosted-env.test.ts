import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { prepareHostedEnvironment, environmentForRole } from '../scripts/hosted-env.ts';

describe('hosted signing boundary', () => {
  it('rejects an upgrade credential renamed as an allowed hosted role',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agentbond-hosted-')),upgrade=Keypair.generate();
    try { await expect(prepareHostedEnvironment({AGENTBOND_DATA_DIR:join(directory,'data'),AGENTBOND_KEY_DIR:join(directory,'keys'),AGENTBOND_UPGRADE_AUTHORITY:upgrade.publicKey.toBase58(),AGENTBOND_WORKER_SECRET_JSON:JSON.stringify([...upgrade.secretKey]),AGENTBOND_VERIFIER_SECRET_JSON:JSON.stringify([...Keypair.generate().secretKey])})).rejects.toThrow('Upgrade authority cannot be used as a hosted signing role'); }
    finally { await rm(directory,{recursive:true,force:true}); }
  });
  it.each(['AGENTBOND_DEPLOYER_SECRET_JSON','AGENTBOND_UPGRADE_AUTHORITY_SECRET_JSON','AGENTBOND_DEPLOYER_KEYPAIR','AGENTBOND_UPGRADE_AUTHORITY_KEYPAIR'])('rejects %s before materializing credentials',async name=>{
    await expect(prepareHostedEnvironment({[name]:'private-value'})).rejects.toThrow('Upgrade/deployer credentials cannot be hosted');
  });
  it('materializes restricted external credentials and excludes unrelated signer paths per role', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbond-hosted-'));
    try {
      const source: NodeJS.ProcessEnv = { AGENTBOND_DATA_DIR: join(directory,'data'), AGENTBOND_KEY_DIR: join(directory,'keys') };
      for (const role of ['WORKER','VERIFIER','FAUCET','MINT_AUTHORITY']) source[`AGENTBOND_${role}_SECRET_JSON`] = JSON.stringify([...Keypair.generate().secretKey]);
      const env = await prepareHostedEnvironment(source);
      expect(Object.keys(env).some(name => name.endsWith('_SECRET_JSON'))).toBe(false);
      expect(Object.keys(source).some(name => name.endsWith('_SECRET_JSON'))).toBe(false);
      expect((await stat(env.AGENTBOND_WORKER_KEYPAIR!)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(env.AGENTBOND_WORKER_KEYPAIR!,'utf8'))).toHaveLength(64);
      const worker = environmentForRole(env,'worker');
      expect(worker.AGENTBOND_WORKER_KEYPAIR).toBeDefined(); expect(worker.AGENTBOND_VERIFIER_KEYPAIR).toBeUndefined(); expect(worker.AGENTBOND_MINT_AUTHORITY_KEYPAIR).toBeUndefined();
      const api = environmentForRole(env,'api');
      expect(api.AGENTBOND_FAUCET_KEYPAIR).toBeDefined(); expect(api.AGENTBOND_WORKER_KEYPAIR).toBeUndefined(); expect(api.AGENTBOND_VERIFIER_KEYPAIR).toBeUndefined();
      expect(env.AGENTBOND_METADATA_STORE).toBe(join(directory,'data','metadata.sqlite'));
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('rejects source-tree keys and invalid credential material without echoing it', async () => {
    await expect(prepareHostedEnvironment({ AGENTBOND_KEY_DIR: join(process.cwd(),'keys') })).rejects.toThrow('outside the source repository');
    const directory = await mkdtemp(join(tmpdir(),'agentbond-hosted-'));
    try {
      await expect(prepareHostedEnvironment({ AGENTBOND_DATA_DIR:join(directory,'data'),AGENTBOND_KEY_DIR:join(directory,'keys'),AGENTBOND_WORKER_SECRET_JSON:'private-secret-invalid' })).rejects.toThrow('Invalid worker signing credential');
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('rejects the same signing wallet assigned to worker and verifier',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agentbond-hosted-'));
    try{const value=JSON.stringify([...Keypair.generate().secretKey]);await expect(prepareHostedEnvironment({AGENTBOND_DATA_DIR:join(directory,'data'),AGENTBOND_KEY_DIR:join(directory,'keys'),AGENTBOND_WORKER_SECRET_JSON:value,AGENTBOND_VERIFIER_SECRET_JSON:value})).rejects.toThrow('distinct wallets');}
    finally{await rm(directory,{recursive:true,force:true});}
  });
});
