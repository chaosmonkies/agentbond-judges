import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { artifactSchema, jobSpecSchema, LIMITS, sha256, type AnalysisArtifact, type JobSpec } from '../../shared/src/index.ts';

export async function executeCsv(input: Uint8Array, untrustedSpec: JobSpec, options: { timeoutMs?: number } = {}): Promise<AnalysisArtifact> {
  const spec = jobSpecSchema.parse(untrustedSpec);
  if (input.byteLength > LIMITS.inputBytes) throw new Error('Input exceeds byte limit');
  if (sha256(input) !== spec.input.hash) throw new Error('Input hash mismatch');
  const csv = new TextDecoder('utf-8', { fatal: true }).decode(input);
  const runner = fileURLToPath(new URL('./csv-sandbox.cjs', import.meta.url));
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? LIMITS.runtimeMs, LIMITS.runtimeMs));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${runner}`, '--max-old-space-size=64', runner], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', finished = false;
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else { try { resolve(artifactSchema.parse(JSON.parse(out))); } catch (e) { reject(e); } } };
    const timer = setTimeout(() => finish(new Error('CSV execution timed out')), timeout);
    child.stdout.on('data', (v: Buffer) => { out += v.toString(); if (out.length > LIMITS.artifactBytes) finish(new Error('Output exceeds byte limit')); });
    child.stderr.on('data', (v: Buffer) => { err = (err + v.toString()).slice(0, 2000); });
    child.on('error', e => finish(e));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`CSV execution failed: ${err || code}`)));
    child.stdin.on('error', e => { if (!finished) finish(e); });
    child.stdin.end(JSON.stringify({ csv, spec }));
  });
}
