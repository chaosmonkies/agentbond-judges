import { mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { LIMITS, sha256 } from '../../../packages/shared/src/index.ts';
import { readBoundedArtifact } from './artifacts.ts';
import { SqliteMetadataStore, type InputRecord } from './sqlite-store.ts';

export class ImmutableInputStore {
  private pending: Promise<unknown> = Promise.resolve();
  readonly root: string; readonly publicApiUrl: string;
  constructor(readonly metadata: SqliteMetadataStore, root: string, publicApiUrl: string) {
    this.root = resolve(root);
    const url = new URL(publicApiUrl);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.includes('..')) throw new Error('Invalid public API URL');
    this.publicApiUrl = url.href.replace(/\/$/, '');
  }
  url(hash: string) { if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid input hash'); return `${this.publicApiUrl}/inputs/${hash}.csv`; }
  put(bytes: Uint8Array, wallet: string): Promise<InputRecord> {
    const result = this.pending.then(() => this.write(bytes, wallet));
    this.pending = result.catch(() => {}); return result;
  }
  private async write(bytes: Uint8Array, wallet: string): Promise<InputRecord> {
    if (!bytes.length || bytes.length > LIMITS.inputBytes) throw new Error('CSV exceeds byte limit or is empty');
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (text.includes('\0') || !text.includes('\n')) throw new Error('CSV requires a header and data row');
    const hash = sha256(bytes); const existing = this.metadata.input(hash);
    if (existing) { await this.get(hash); return existing; }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, hash + '.csv');
    let created = false;
    try { const file = await open(path, 'wx', 0o600); created = true; try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } const dir = await open(this.root, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (sha256(await readBoundedArtifact(path, this.root, LIMITS.inputBytes)) !== hash) throw new Error('Existing immutable input differs from hash'); }
    try { return this.metadata.putInput({ hash, owner: wallet, bytes: bytes.length, path, createdAt: Date.now() }); }
    catch (error) { if (created && !this.metadata.input(hash)) await unlink(path).catch(() => {}); throw error; }
  }
  async get(hash: string): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid input hash');
    const record = this.metadata.input(hash); if (!record) throw new Error('Input not found');
    const bytes = await readBoundedArtifact(record.path, this.root, LIMITS.inputBytes);
    if (sha256(bytes) !== hash || bytes.length !== record.bytes) throw new Error('Immutable input integrity failure');
    return bytes;
  }
  /** Exact owned URLs map to local immutable storage; marketplace URLs never reach DNS. */
  async resolveOwned(url: string, expectedHash: string): Promise<Uint8Array> {
    if (url !== this.url(expectedHash)) throw new Error('Input URL is not an exact owned immutable hash path');
    return this.get(expectedHash);
  }
}
