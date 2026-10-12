import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentProfile } from '../../../packages/shared/src/index.ts';
import type { JobMetadata, MetadataRepository } from './store.ts';

export interface InputRecord { hash: string; owner: string; bytes: number; path: string; createdAt: number }
export interface Heartbeat { service: string; time: number; healthy: boolean; detail: string }
export class SqliteMetadataStore implements MetadataRepository {
  private database: DatabaseSync | null = null;
  constructor(readonly file: string) {}
  private get db() { if (!this.database) throw new Error('SQLite store must be loaded'); return this.database; }
  async load() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(address TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs(hash TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS heartbeats(service TEXT PRIMARY KEY, time INTEGER NOT NULL, healthy INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS faucet_quotas(wallet TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_leases(service TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inputs_owner_time ON inputs(owner,created_at);`);
  }
  close() { this.database?.close(); this.database = null; }
  jobs(): JobMetadata[] { return this.db.prepare('SELECT payload FROM jobs ORDER BY address').all().map(row => JSON.parse(String(row.payload))); }
  agents(): AgentProfile[] { return this.db.prepare('SELECT payload FROM agents ORDER BY id').all().map(row => JSON.parse(String(row.payload))); }
  job(address: string): JobMetadata|null { const row = this.db.prepare('SELECT payload FROM jobs WHERE address=?').get(address); return row ? JSON.parse(String(row.payload)) : null; }
  async putJob(job: JobMetadata) { this.db.prepare('INSERT INTO jobs(address,payload) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload').run(job.address, JSON.stringify(job)); }
  async putAgent(agent: AgentProfile) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT wallet FROM agents WHERE id=?').get(agent.id);
      if (prior && prior.wallet !== agent.wallet) throw new Error('Agent ID belongs to another wallet');
      this.db.prepare('DELETE FROM agents WHERE wallet=? AND id<>?').run(agent.wallet, agent.id);
      this.db.prepare('INSERT INTO agents(id,wallet,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(agent.id, agent.wallet, JSON.stringify(agent));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  input(hash: string): InputRecord|null {
    const row = this.db.prepare('SELECT * FROM inputs WHERE hash=?').get(hash);
    return row ? { hash: String(row.hash), owner: String(row.owner), bytes: Number(row.bytes), path: String(row.path), createdAt: Number(row.created_at) } : null;
  }
  putInput(record: InputRecord, maxPerWallet = 20) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.input(record.hash)) {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM inputs WHERE owner=? AND created_at>=?').get(record.owner, record.createdAt - 86400000);
        if (Number(count?.n ?? 0) >= maxPerWallet) throw new Error('Daily input upload quota reached');
        const total = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM inputs').get();
        if (Number(total?.n ?? 0) + record.bytes > 256 * 1024 * 1024) throw new Error('Input storage capacity reached');
        this.db.prepare('INSERT INTO inputs(hash,owner,bytes,path,created_at) VALUES(?,?,?,?,?)').run(record.hash, record.owner, record.bytes, record.path, record.createdAt);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.input(record.hash)!;
  }
  heartbeat(value: Heartbeat) { this.db.prepare('INSERT INTO heartbeats(service,time,healthy,detail) VALUES(?,?,?,?) ON CONFLICT(service) DO UPDATE SET time=excluded.time,healthy=excluded.healthy,detail=excluded.detail').run(value.service, value.time, value.healthy ? 1 : 0, value.detail.slice(0,1000)); }
  heartbeats(): Heartbeat[] { return this.db.prepare('SELECT * FROM heartbeats ORDER BY service').all().map(row => ({ service: String(row.service), time: Number(row.time), healthy: !!row.healthy, detail: String(row.detail) })); }
  reserveFaucet(wallet: string, payload: unknown, maxWallets = 100): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.faucet(wallet)) { this.db.exec('COMMIT'); return false; }
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM faucet_quotas').get();
      if (Number(count?.n ?? 0) >= maxWallets) throw new Error('Devnet faucet lifetime capacity reached');
      const created = this.db.prepare('INSERT INTO faucet_quotas(wallet,state,payload) VALUES(?,?,?)').run(wallet,'PENDING',JSON.stringify(payload)).changes === 1;
      this.db.exec('COMMIT'); return created;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  faucet(wallet: string): { state: string; payload: any }|null { const row = this.db.prepare('SELECT state,payload FROM faucet_quotas WHERE wallet=?').get(wallet); return row ? { state: String(row.state), payload: JSON.parse(String(row.payload)) } : null; }
  updateFaucet(wallet: string, state: string, payload: unknown) { this.db.prepare('UPDATE faucet_quotas SET state=?,payload=? WHERE wallet=?').run(state, JSON.stringify(payload), wallet); }
  faucetCount(): number { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM faucet_quotas').get()?.n ?? 0); }
  acquireLease(service: string, owner: string, now = Date.now(), lifetime = 60000): boolean {
    return this.db.prepare('INSERT INTO service_leases(service,owner,expires_at) VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE service_leases.owner=excluded.owner OR service_leases.expires_at<=?').run(service,owner,now+lifetime,now).changes === 1;
  }
  releaseLease(service: string, owner: string) { this.db.prepare('DELETE FROM service_leases WHERE service=? AND owner=?').run(service,owner); }
}
