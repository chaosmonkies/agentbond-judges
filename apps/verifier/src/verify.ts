import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { artifactSchema, jobSpecSchema, LIMITS, sha256, specificationHashes, type JobSpec } from '../../../packages/shared/src/index.ts';

export const verificationReceiptSchema = z.object({
  version: z.literal(1), jobAddress: z.string(), approved: z.boolean(),
  artifactHash: z.string().regex(/^[0-9a-f]{64}$/), inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  specHash: z.string().regex(/^[0-9a-f]{64}$/), checkedAt: z.number().int().nonnegative(), reasons: z.array(z.string()),
}).strict();
export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;
// This parser and calculation are deliberately independent of the worker's runner.
// It consumes CSV fields with a cursor rather than the worker's streaming accumulator.
function parseCsvIndependent(text: string): string[][] {
  const records: string[][] = []; let cursor = 0;
  while (cursor < text.length) {
    const record: string[] = []; let recordEnded = false;
    while (!recordEnded) {
      let value = '';
      if (text[cursor] === '"') {
        cursor++; let foundEnd = false;
        while (cursor < text.length) {
          const part = text[cursor++];
          if (part === '"') {
            if (text[cursor] === '"') { value += '"'; cursor++; }
            else { foundEnd = true; break; }
          } else value += part;
          if (value.length > 10000) throw new Error('CSV cell limit');
        }
        if (!foundEnd || (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor]))) throw new Error('Malformed quoted CSV');
      } else {
        const start = cursor;
        while (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor])) cursor++;
        value = text.slice(start, cursor);
        if (value.includes('"') || value.length > 10000) throw new Error('Malformed unquoted CSV');
      }
      record.push(value);
      if (record.length > LIMITS.columns) throw new Error('CSV column limit');
      const separator = text[cursor++];
      if (separator === ',') continue;
      if (separator === '\r' && text[cursor] === '\n') cursor++;
      recordEnded = true;
    }
    records.push(record);
    if (records.length > LIMITS.rows + 1) throw new Error('CSV row limit');
  }
  return records;
}

export function verifyArtifact(input: Uint8Array, bytes: Uint8Array, expectedArtifactHash: string, untrustedSpec: JobSpec, jobAddress = ''): VerificationReceipt {
  const spec = jobSpecSchema.parse(untrustedSpec);
  const receipt: VerificationReceipt = { version: 1, jobAddress, approved: false, artifactHash: sha256(bytes), inputHash: sha256(input), specHash: specificationHashes(spec).specHash, checkedAt: Math.floor(Date.now() / 1000), reasons: [] };
  try {
    if (input.length > LIMITS.inputBytes || bytes.length > LIMITS.artifactBytes) throw new Error('Verification resource limit');
    if (receipt.inputHash !== spec.input.hash) throw new Error('Input hash mismatch');
    if (receipt.artifactHash !== expectedArtifactHash) throw new Error('Artifact hash mismatch');
    const decode = new TextDecoder('utf-8', { fatal: true });
    const artifact = artifactSchema.parse(JSON.parse(decode.decode(bytes)));
    if (artifact.inputHash !== receipt.inputHash) throw new Error('Artifact input commitment mismatch');
    const records = parseCsvIndependent(decode.decode(input));
    if (records.length < 2) throw new Error('Empty CSV');
    const headings = records[0], data = records.slice(1);
    if (new Set(headings).size !== headings.length || headings.some(v => !v || v.length > 100)) throw new Error('Invalid CSV headings');
    if (data.some(v => v.length !== headings.length)) throw new Error('Invalid CSV width');
    if (artifact.rowCount !== data.length) throw new Error('Row count mismatch');
    if (Object.keys(artifact.columns).sort().join('\0') !== [...spec.acceptance.numericColumns].sort().join('\0')) throw new Error('Column set mismatch');
    const expectedAnomalies: { row: number; column: string; value: number }[] = [];
    for (const name of spec.acceptance.numericColumns) {
      const offset = headings.indexOf(name); if (offset < 0) throw new Error('Missing column');
      const values = data.map(row => {
        const value = row[offset].trim();
        if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) throw new Error('Invalid numeric cell');
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e12) throw new Error('Numeric bound exceeded');
        return parsed;
      });
      const actual = artifact.columns[name];
      const total = values.reduce((a,b) => a + b, 0);
      const expected = { count: values.length, sum: total, mean: total / values.length, min: Math.min(...values), max: Math.max(...values) };
      for (const k of ['count', 'sum', 'mean', 'min', 'max'] as const) if (actual[k] !== expected[k]) throw new Error(`${name}.${k} mismatch`);
      if (name === spec.acceptance.anomaly.column) values.forEach((value, index) => {
        const anomaly = spec.acceptance.anomaly;
        if (anomaly.direction === 'above' ? value > anomaly.threshold : value < anomaly.threshold) expectedAnomalies.push({ row: index + 1, column: name, value });
      });
    }
    if (JSON.stringify(artifact.anomalies) !== JSON.stringify(expectedAnomalies)) throw new Error('Anomaly mismatch');
    receipt.approved = true;
  } catch (error) { receipt.reasons.push(error instanceof Error ? error.message : 'Verification failed'); }
  return receipt;
}
