import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedArtifact } from '../../apps/api/src/artifacts.ts';
import { loadExternalKeypair } from '../../packages/agent-runtime/src/signing.ts';
import { Keypair } from '@solana/web3.js';

describe('artifact filesystem boundary', () => {
  const paths: string[] = [];
  afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
  it('rejects path traversal, symlinks escaping root, oversized files and directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbond-files-')); paths.push(directory);
    const root = join(directory, 'artifacts'); await mkdir(root);
    const privateFile = join(directory, 'outside.json'); await writeFile(privateFile, 'secret');
    await symlink(privateFile, join(root, 'link.json'));
    await expect(readBoundedArtifact(privateFile, root)).rejects.toThrow('outside');
    await expect(readBoundedArtifact(join(root, 'link.json'), root)).rejects.toThrow('outside');
    await writeFile(join(root, 'big.json'), Buffer.alloc(101));
    await expect(readBoundedArtifact(join(root, 'big.json'), root, 100)).rejects.toThrow('limit');
    await mkdir(join(root, 'directory')); await expect(readBoundedArtifact(join(root, 'directory'), root)).rejects.toThrow('unsupported');
    await writeFile(join(root, 'valid.json'), '{}'); expect((await readBoundedArtifact(join(root, 'valid.json'), root)).toString()).toBe('{}');
  });
  it('keeps signing keys outside repository after symlink resolution and restricts mode/content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentbond-signing-')); paths.push(directory);
    const repo = join(directory, 'repo'); await mkdir(repo); const key = Keypair.generate();
    const external = join(directory, 'key.json'); await writeFile(external, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
    expect((await loadExternalKeypair(external, repo)).publicKey.toBase58()).toBe(key.publicKey.toBase58());
    await chmod(external, 0o644); await expect(loadExternalKeypair(external, repo)).rejects.toThrow('restricted');
    const inside = join(repo, 'inside.json'); await writeFile(inside, JSON.stringify(Array.from(key.secretKey)), { mode: 0o600 });
    const link = join(directory, 'link.json'); await symlink(inside, link); await expect(loadExternalKeypair(link, repo)).rejects.toThrow('outside repository');
    await chmod(external, 0o600); await writeFile(external, 'never echo secret contents'); await expect(loadExternalKeypair(external, repo)).rejects.toThrow(/^Invalid signing key file$/);
  });
});
