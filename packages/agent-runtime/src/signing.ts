import { Keypair } from '@solana/web3.js';
import { realpath, stat, readFile } from 'node:fs/promises';
import { sep } from 'node:path';

export async function loadExternalKeypair(path: string, repository = process.cwd()): Promise<Keypair> {
  const [keyPath, repositoryPath] = await Promise.all([realpath(path), realpath(repository)]);
  if (keyPath === repositoryPath || keyPath.startsWith(repositoryPath + sep)) throw new Error('Signing key must be outside repository');
  const info = await stat(keyPath);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 4096) throw new Error('Signing key must be a bounded restricted file with mode0600');
  try {
    const values: unknown = JSON.parse(await readFile(keyPath, 'utf8'));
    if (!Array.isArray(values) || values.length !== 64 || values.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(values));
  } catch { throw new Error('Invalid signing key file'); }
}
