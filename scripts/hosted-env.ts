import { mkdir, chmod, writeFile, lstat, chown } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { loadExternalKeypair } from '../packages/agent-runtime/src/signing.ts';

const roles = ['worker', 'verifier', 'faucet', 'mint_authority'] as const;
export type HostedRole = typeof roles[number];
export async function prepareHostedEnvironment(source: NodeJS.ProcessEnv, repository = process.cwd()) {
  if (source.AGENTBOND_DEPLOYER_SECRET_JSON || source.AGENTBOND_UPGRADE_AUTHORITY_SECRET_JSON || source.AGENTBOND_DEPLOYER_KEYPAIR || source.AGENTBOND_UPGRADE_AUTHORITY_KEYPAIR) throw new Error('Upgrade/deployer credentials cannot be hosted');
  const env = { ...source };
  const data = resolve(env.AGENTBOND_DATA_DIR ?? '/data');
  const keys = resolve(env.AGENTBOND_KEY_DIR ?? '/run/agentbond');
  const inside = (path: string) => { const value = relative(resolve(repository), path); return !value.startsWith('..') && !isAbsolute(value); };
  if (inside(data) || inside(keys)) throw new Error('Hosted data and signing keys must be outside the source repository');
  for (const dir of [data, keys, ...['inputs','artifacts','journals','health'].map(name => join(data, name))]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Hosted directories cannot be symlinks');
    await chmod(dir, 0o700);
  }
  for (const role of roles) {
    const variable = `AGENTBOND_${role.toUpperCase()}_SECRET_JSON`;
    const value = env[variable];
    delete env[variable]; delete source[variable];
    if (!value) continue;
    let bytes: unknown;
    try { bytes = JSON.parse(value); } catch { throw new Error(`Invalid ${role} signing credential`); }
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error(`Invalid ${role} signing credential`);
    try { Keypair.fromSecretKey(Uint8Array.from(bytes)); } catch { throw new Error(`Invalid ${role} signing credential`); }
    const file = join(keys, `${role}.json`);
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Signing file cannot be a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(file, JSON.stringify(bytes), { mode: 0o600 }); await chmod(file, 0o600);
    env[`AGENTBOND_${role.toUpperCase()}_KEYPAIR`] = file;
  }
  if (!env.AGENTBOND_WORKER_KEYPAIR || !env.AGENTBOND_VERIFIER_KEYPAIR) throw new Error('Hosted worker and verifier signing credentials are required');
  const signingWallets = new Set<string>();
  for (const role of roles) {
    const file = env[`AGENTBOND_${role.toUpperCase()}_KEYPAIR`];
    if (!file) continue;
    const wallet = (await loadExternalKeypair(file,repository)).publicKey.toBase58();
    const upgradeAuthority=env.AGENTBOND_UPGRADE_AUTHORITY ?? (env.AGENTBOND_NETWORK==='devnet'?'6aaxsWgNfc1b6aiPiMfa5PiPq96721DSXYcBerz8dVVD':undefined);
    if(wallet===upgradeAuthority)throw new Error('Upgrade authority cannot be used as a hosted signing role');
    if (signingWallets.has(wallet)) throw new Error('Hosted signing roles require distinct wallets');
    signingWallets.add(wallet);
    if (role==='worker') env.AGENTBOND_WORKER_ADDRESS=wallet;
  }
  env.AGENTBOND_HOSTED = '1';
  env.AGENTBOND_DATA_DIR = data;
  env.AGENTBOND_METADATA_STORE = join(data, 'metadata.sqlite');
  env.AGENTBOND_INPUT_ROOT = join(data, 'inputs');
  env.AGENTBOND_ARTIFACT_ROOT = join(data, 'artifacts');
  env.AGENTBOND_TRANSACTION_JOURNAL = join(data, 'journals');
  env.AGENTBOND_HEALTH_ROOT = join(data, 'health');
  env.API_HOST = '0.0.0.0';
  env.PORT = env.PORT ?? '4100';
  if (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) throw new Error('Invalid hosted PORT');
  env.AGENTBOND_API_URL = `http://127.0.0.1:${env.PORT}`;
  if (env.AGENTBOND_DROP_UID) {
    const uid = Number(env.AGENTBOND_DROP_UID), gid = Number(env.AGENTBOND_DROP_GID ?? uid);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1 || process.getuid?.() !== 0) throw new Error('Invalid privilege drop configuration');
    for (const dir of [data, keys, ...['inputs','artifacts','journals','health'].map(name => join(data, name))]) await chown(dir, uid, gid);
    for (const role of roles) { const file = env[`AGENTBOND_${role.toUpperCase()}_KEYPAIR`]; if (file) { const info=await lstat(file); if(info.uid!==uid || info.gid!==gid)await chown(file, uid, gid); } }
    process.setgroups!([]);
    process.setgid!(gid); process.setuid!(uid);
  }
  return env;
}

export function environmentForRole(env: NodeJS.ProcessEnv, role: 'api' | 'worker' | 'verifier') {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (name.endsWith('_SECRET_JSON')) delete result[name];
    if (name.endsWith('_KEYPAIR')) {
      const allowed = role === 'api' ? ['AGENTBOND_FAUCET_KEYPAIR','AGENTBOND_MINT_AUTHORITY_KEYPAIR'] : [`AGENTBOND_${role.toUpperCase()}_KEYPAIR`];
      if (!allowed.includes(name)) delete result[name];
    }
  }
  return result;
}
