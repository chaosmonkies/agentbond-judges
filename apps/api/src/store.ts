import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentProfile, JobSpec } from '../../../packages/shared/src/index.ts';

export interface JobMetadata { address: string; title?: string; spec: JobSpec; artifactPath?: string; receiptPath?: string }
export interface MetadataRepository {
  load(): Promise<void>; jobs(): JobMetadata[]; agents(): AgentProfile[]; job(address: string): JobMetadata|null;
  putJob(job: JobMetadata): Promise<void>; putAgent(agent: AgentProfile): Promise<void>;
}
interface StoredData { version: 1; agents: AgentProfile[]; jobs: JobMetadata[] }
export class MetadataStore implements MetadataRepository {
  private data: StoredData = { version: 1, agents: [], jobs: [] };
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as StoredData;
      if (data.version !== 1 || !Array.isArray(data.jobs) || !Array.isArray(data.agents)) throw new Error('Invalid metadata store');
      this.data = data;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  jobs() { return structuredClone(this.data.jobs); }
  agents() { return structuredClone(this.data.agents); }
  job(address: string) { return structuredClone(this.data.jobs.find(v => v.address === address) ?? null); }
  private mutate(change: (data: StoredData) => void) {
    const next = this.serial.then(async () => {
      const data = structuredClone(this.data); change(data);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(tmp, this.file);
      this.data = data;
    });
    this.serial = next.catch(() => {}); return next;
  }
  putJob(job: JobMetadata) { return this.mutate(data => { data.jobs = [...data.jobs.filter(v => v.address !== job.address), job]; }); }
  putAgent(agent: AgentProfile) {
    return this.mutate(data => {
      const owner = data.agents.find(v => v.id === agent.id);
      if (owner && owner.wallet !== agent.wallet) throw new Error('Agent ID belongs to another wallet');
      data.agents = [...data.agents.filter(v => v.id !== agent.id && v.wallet !== agent.wallet), agent];
    });
  }
}
