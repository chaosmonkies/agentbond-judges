import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { LIMITS, sha256 } from '../../shared/src/index.ts';

export interface InputPolicy { allowedOrigins: string[]; allowLoopback?: boolean; maxBytes?: number; timeoutMs?: number; ownedResolver?: (url: string, expectedHash: string) => Promise<Uint8Array> }
function privateAddress(ip: string): boolean {
  if (ip.includes(':')) return !/^[23][0-9a-f]{3}:/i.test(ip);
  const [a,b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export async function fetchInput(urlString: string, expectedHash: string, policy: InputPolicy): Promise<Uint8Array> {
  if (policy.ownedResolver) {
    // This mode has no network fallback, including when an owned file is absent.
    const bytes = await policy.ownedResolver(urlString, expectedHash);
    if (bytes.length > Math.min(policy.maxBytes ?? LIMITS.inputBytes, LIMITS.inputBytes)) throw new Error('Input exceeds byte limit');
    if (sha256(bytes) !== expectedHash) throw new Error('Input hash mismatch');
    return bytes;
  }
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Unsupported input URL');
  if (!policy.allowedOrigins.includes(url.origin)) throw new Error('Input origin is not allowlisted');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  const loopback = addresses.every(v => v.address === '127.0.0.1' || v.address === '::1');
  if (addresses.some(v => privateAddress(v.address)) && !(policy.allowLoopback && loopback)) throw new Error('Private network input forbidden');
  // The fetch is only an ingestion step; the executor itself has no network interface.
  // Literal IP allowlists avoid DNS rebinding. Hostname inputs are deliberately rejected.
  if (!isIP(hostname)) throw new Error('Use a pinned IP input origin to prevent DNS rebinding');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(policy.timeoutMs ?? 5000) });
  if (!response.ok || !response.body) throw new Error(`Input fetch failed: ${response.status}`);
  const max = Math.min(policy.maxBytes ?? LIMITS.inputBytes, LIMITS.inputBytes);
  if (Number(response.headers.get('content-length')) > max) throw new Error('Input exceeds byte limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('Input exceeds byte limit'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expectedHash) throw new Error('Input hash mismatch');
  return bytes;
}
