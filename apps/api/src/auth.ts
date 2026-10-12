import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { hashSchema, sha256 } from '../../../packages/shared/src/index.ts';

export type AuthAction = 'register-agent' | 'job-metadata' | 'upload-input' | 'request-faucet';
const challengeRequest = z.object({ wallet: z.string(), action: z.enum(['register-agent', 'job-metadata', 'upload-input', 'request-faucet']), bodyHash: hashSchema }).strict();
const authRequest = z.object({ wallet: z.string(), nonce: z.string().regex(/^[0-9a-f]{64}$/), signature: z.string().max(100) }).strict();
interface Challenge { wallet: string; action: string; bodyHash: string; message: string; expiresAt: number }
export class WalletAuth {
  private challenges = new Map<string, Challenge>();
  private issued = new Map<string, { count: number; window: number }>();
  constructor(readonly domain: string, private clock = () => Date.now()) {
    if (!domain || /[\r\n]/.test(domain)) throw new Error('Invalid auth domain');
  }
  challenge(body: unknown) {
    const request = challengeRequest.parse(body); const wallet = new PublicKey(request.wallet);
    if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error('Wallet must be a signing public key');
    const now = this.clock();
    for (const [nonce, challenge] of this.challenges) if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    for (const [key, limit] of this.issued) if (now - limit.window >= 60000) this.issued.delete(key);
    if (this.challenges.size >= 1000) throw new Error('Challenge capacity reached');
    const limit = this.issued.get(request.wallet) ?? { count: 0, window: now };
    if (now - limit.window < 60000 && limit.count >= 10) throw new Error('Challenge rate limit');
    limit.count++; this.issued.set(request.wallet, limit);
    const nonce = randomBytes(32).toString('hex'); const expiresAt = now + 60000;
    const message = `AgentBond wallet authorization\nDomain: ${this.domain}\nWallet: ${request.wallet}\nAction: ${request.action}\nBody SHA256: ${request.bodyHash}\nNonce: ${nonce}\nIssued at: ${new Date(now).toISOString()}\nExpires at: ${new Date(expiresAt).toISOString()}`;
    this.challenges.set(nonce, { ...request, message, expiresAt });
    return { nonce, message, expiresAt, domain: this.domain };
  }
  authorize(header: string | undefined, action: AuthAction, rawBody: string | Uint8Array): string {
    if (!header?.startsWith('AgentBond ') || header.length > 1024) throw new Error('Wallet authorization required');
    const auth = authRequest.parse(JSON.parse(Buffer.from(header.slice(10), 'base64').toString('utf8')));
    const challenge = this.challenges.get(auth.nonce);
    if (!challenge || challenge.expiresAt <= this.clock()) { this.challenges.delete(auth.nonce); throw new Error('Unknown, expired or consumed nonce'); }
    if (challenge.wallet !== auth.wallet || challenge.action !== action || challenge.bodyHash !== sha256(rawBody)) throw new Error('Authorization scope mismatch');
    const signature = Buffer.from(auth.signature, 'base64');
    if (signature.length !== 64 || !nacl.sign.detached.verify(Buffer.from(challenge.message), signature, new PublicKey(auth.wallet).toBytes())) throw new Error('Invalid wallet signature');
    this.challenges.delete(auth.nonce); // Atomic synchronous consume before any asynchronous mutation.
    return auth.wallet;
  }
}
