import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareHostedEnvironment, environmentForRole } from './hosted-env.ts';
import { seedHostedHistory } from './hosted-seed.ts';

const env = await prepareHostedEnvironment(process.env);
await seedHostedHistory(env);
const children = new Map<string, ChildProcess>();
const timers = new Set<NodeJS.Timeout>();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const child of children.values()) child.kill('SIGTERM');
  const force = setTimeout(() => { for (const child of children.values()) child.kill('SIGKILL'); process.exit(code); }, 10_000);
  const interval = setInterval(() => { if ([...children.values()].every(child => child.exitCode !== null || child.signalCode !== null)) { clearTimeout(force); clearInterval(interval); process.exit(code); } }, 100);
}
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
process.on('uncaughtException', () => { console.error('Hosted supervisor failed'); stop(1); });
const paths = { api: 'apps/api/src/main.ts', worker: 'apps/worker/src/main.ts', verifier: 'apps/verifier/src/main.ts' };
function launch(role: keyof typeof paths, failures = 0) {
  if (stopping) return;
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', paths[role], ...(role === 'api' ? [] : ['--watch'])], { stdio: 'inherit', env: environmentForRole(env, role) });
  children.set(role, child);
  child.on('error', () => { console.error(`${role} failed to launch`); stop(1); });
  child.on('exit', () => {
    if (stopping) return;
    const nextFailures = Date.now() - started > 60_000 ? 1 : failures + 1;
    if (nextFailures > 10) { console.error(`${role} repeatedly failed; requesting host restart`); stop(1); return; }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(nextFailures - 1, 5));
    console.error(`${role} exited; restart in ${delay}ms`);
    const timer = setTimeout(() => { timers.delete(timer); launch(role, nextFailures); }, delay); timers.add(timer);
  });
}
launch('api');
const deadline = Date.now() + 120_000;
while (!stopping) {
  if (await fetch(`${env.AGENTBOND_API_URL}/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok).catch(() => false)) break;
  if (Date.now() > deadline) { console.error('Hosted API readiness timeout'); stop(1); break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!stopping) {
  launch('worker'); launch('verifier');
  console.log('AgentBond hosted API, worker and verifier supervised');
  const actorStartup = Date.now();
  const watchdog = setInterval(async () => {
    if (stopping || Date.now() - actorStartup < 180_000) return;
    for (const role of ['worker','verifier'] as const) {
      try {
        const heartbeat = JSON.parse(await readFile(join(env.AGENTBOND_HEALTH_ROOT!, `${role}.json`), 'utf8'));
        const value = heartbeat.time ?? heartbeat.at ?? heartbeat.updatedAt ?? heartbeat.timestamp;
        const updated = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(updated) || Date.now() - updated > 180_000) throw new Error('stale');
      } catch { const child = children.get(role); if (child && child.exitCode === null && child.signalCode === null) { console.error(`${role} heartbeat stale; stopping host for clean recovery`); stop(1); } }
    }
  }, 30_000);
  timers.add(watchdog);
}
