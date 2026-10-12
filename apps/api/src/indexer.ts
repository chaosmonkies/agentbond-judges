export interface ChainJob {
  address: string; status: string; creator: string; worker: string | null; verifier: string; mint?: string;
  specHash: string; acceptanceHash: string; artifactHash: string; verificationHash: string; amount: string;
}
export interface ChainEvent { signature: string; slot: number; blockTime: number | null; confirmationStatus: string | null; action?: string; error?: unknown }
export interface ChainReader { listJobs(): Promise<ChainJob[]>; getJob(address: string): Promise<ChainJob | null>; events(address: string): Promise<ChainEvent[]> }

// The index is a convenience cache. All authoritative reads attempt fresh RPC.
// A failed read returns an error and never serves cached state as current.
export class ChainIndex {
  private eventsByJob = new Map<string, Map<string, ChainEvent>>();
  private jobs = new Map<string, ChainJob>();
  lastSuccessfulRead: number | null = null;
  lastSnapshotRead: number|null=null;
  lastError: string | null = null;
  private snapshot: {jobs:ChainJob[];at:number}|null=null;
  private flight: Promise<ChainJob[]>|null=null;
  private jobFlights=new Map<string,Promise<ChainJob|null>>();
  private eventFlights=new Map<string,Promise<ChainEvent[]>>();
  private generation=0;
  constructor(readonly reader: ChainReader,readonly options: {cacheMs?:number;now?:()=>number;knownAddresses?:()=>string[]}={}) {
    if (!Number.isFinite(options.cacheMs ?? 0) || (options.cacheMs ?? 0)<0 || (options.cacheMs ?? 0)>1000) throw new Error('Authoritative snapshot reuse must be from 0 to 1000ms');
  }
  invalidateSnapshot() { this.snapshot=null;this.generation++; }
  reconcile(): Promise<ChainJob[]> {
    if (this.flight) return this.flight;
    const now=this.options.now ?? Date.now;
    if (this.snapshot && now()-this.snapshot.at<(this.options.cacheMs ?? 0)) return Promise.resolve(structuredClone(this.snapshot.jobs));
    const generation=this.generation;
    const pending=(async()=>{try {
      const jobs = [...await this.reader.listJobs()];
      const seen=new Set(jobs.map(job=>job.address));
      // RPC account scans can lag a just-created account. Registered metadata is
      // only an address hint; missing addresses require a fresh account read.
      const missing=[...new Set(this.options.knownAddresses?.() ?? [])].filter(address=>!seen.has(address)).slice(0,20);
      for (const address of missing) { const job=await this.get(address); if(job)jobs.push(job); }
      this.jobs = new Map(jobs.map(job => [job.address, job]));
      this.lastSuccessfulRead = now(); this.lastSnapshotRead=this.lastSuccessfulRead; this.lastError = null;
      if(generation===this.generation)this.snapshot={jobs:structuredClone(jobs),at:now()};
      return jobs;
    } catch (error) { this.snapshot=null;this.lastError = error instanceof Error ? error.message : String(error); throw error; }})();
    this.flight=pending;void pending.finally(()=>{if(this.flight===pending)this.flight=null;}).catch(()=>{});return pending;
  }
  get(address: string): Promise<ChainJob | null> {
    const prior=this.jobFlights.get(address);if(prior)return prior;
    const pending=this.readJob(address);this.jobFlights.set(address,pending);void pending.finally(()=>this.jobFlights.delete(address)).catch(()=>{});return pending;
  }
  private async readJob(address:string):Promise<ChainJob|null> {
    try { const job = await this.reader.getJob(address); if (job) this.jobs.set(address, job); else this.jobs.delete(address); this.lastSuccessfulRead = Date.now(); this.lastError = null; return job; }
    catch (error) { this.snapshot=null; this.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }
  events(address: string): Promise<ChainEvent[]> {
    const prior=this.eventFlights.get(address);if(prior)return prior;
    const pending=this.readEvents(address);this.eventFlights.set(address,pending);void pending.finally(()=>this.eventFlights.delete(address)).catch(()=>{});return pending;
  }
  private async readEvents(address:string):Promise<ChainEvent[]> {
    let observed:ChainEvent[];
    try { observed=await this.reader.events(address); }
    catch(error){this.snapshot=null;this.lastError=error instanceof Error?error.message:String(error);throw error;}
    const dedup = this.eventsByJob.get(address) ?? new Map<string, ChainEvent>();
    // Persist only finalized signatures across polls. Confirmed observations are
    // returned for live UX but must be reobserved after an RPC interruption.
    for (const [signature, event] of dedup) if (event.confirmationStatus !== 'finalized') dedup.delete(signature);
    for (const event of observed) {
      if (event.error) dedup.delete(event.signature);
      else if (['confirmed', 'finalized'].includes(event.confirmationStatus ?? '')) dedup.set(event.signature, event);
    }
    if(dedup.size>128){const keep=[...dedup.values()].sort((a,b)=>b.slot-a.slot).slice(0,128);dedup.clear();for(const event of keep)dedup.set(event.signature,event);}
    this.eventsByJob.delete(address);this.eventsByJob.set(address,dedup);
    while(this.eventsByJob.size>512)this.eventsByJob.delete(this.eventsByJob.keys().next().value!);
    return [...dedup.values()].sort((a,b) => a.slot - b.slot);
  }
}
