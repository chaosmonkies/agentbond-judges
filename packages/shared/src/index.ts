import { createHash } from 'node:crypto';
import { z } from 'zod';

export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const jobSpecSchema = z.object({
  type: z.literal('csv-analysis'),
  input: z.object({ url: z.string().url().max(2048), hash: hashSchema }).strict(),
  acceptance: z.object({
    numericColumns: z.array(z.string().min(1).max(100)).min(1).max(64)
      .refine(v => new Set(v).size === v.length, 'Duplicate numeric columns'),
    anomaly: z.object({ column: z.string().min(1).max(100), threshold: z.number().finite(), direction: z.enum(['above', 'below']) }).strict(),
  }).strict(),
}).strict().refine(v => v.acceptance.numericColumns.includes(v.acceptance.anomaly.column), 'Anomaly column must be numeric');
export type JobSpec = z.infer<typeof jobSpecSchema>;

export const artifactSchema = z.object({
  version: z.literal(1), inputHash: hashSchema,
  rowCount: z.number().int().min(1).max(10000),
  columns: z.record(z.object({ count: z.number().int().min(1).max(10000), sum: z.number().finite(), mean: z.number().finite(), min: z.number().finite(), max: z.number().finite() }).strict()),
  anomalies: z.array(z.object({ row: z.number().int().min(1).max(10000), column: z.string(), value: z.number().finite() }).strict()).max(10000),
}).strict();
export type AnalysisArtifact = z.infer<typeof artifactSchema>;
export const agentProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), wallet: z.string().min(32).max(44),
  capabilities: z.array(z.string().min(1).max(100)).max(20), taskTypes: z.array(z.literal('csv-analysis')).min(1),
  endpoint: z.string().url().max(2048).optional(), maxRuntimeMs: z.number().int().min(100).max(10000),
  metadata: z.record(z.string().max(2000)).optional(),
}).strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}
export function specificationHashes(spec: JobSpec) {
  const parsed = jobSpecSchema.parse(spec);
  return { specHash: sha256(stableStringify(parsed)), acceptanceHash: sha256(stableStringify(parsed.acceptance)) };
}
export const LIMITS = Object.freeze({ inputBytes: 1024 * 1024, artifactBytes: 2 * 1024 * 1024, rows: 10000, columns: 64, runtimeMs: 2000 });
