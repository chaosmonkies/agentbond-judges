import { PublicKey } from '@solana/web3.js';

export type NetworkName = 'devnet' | 'localnet' | 'mainnet-beta';
export const NETWORK_GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
export interface NetworkProfile {
  readonly network: NetworkName;
  readonly rpcUrl: string;
  readonly genesisHash: string;
  readonly programId: string;
  readonly mint: string;
  readonly verifier: string;
  readonly decimals: number;
  readonly enableMainnet: boolean;
  readonly faucetEnabled: boolean;
  readonly tokenName: string;
}
export interface NetworkConfig {
  network: string;
  rpcUrl?: string;
  genesisHash?: string;
  programId?: string;
  mint?: string;
  verifier?: string;
  decimals?: number;
  enableMainnet?: boolean;
}
export const DEVNET_PROFILE: NetworkProfile = Object.freeze({
  network: 'devnet', rpcUrl: 'https://api.devnet.solana.com', genesisHash: NETWORK_GENESIS.devnet,
  programId: 'FPymWjwqaqmXQ3ozKNRdBP9FNyWqQcE5TepHvUBgMB1U',
  mint: '5XBm9mTbKp2URS4ptgukSnCWneXpfiwh7eNpHZK9AoiQ',
  verifier: '6kjotF9c7xbmxJjdRqyqc5jnmPTfqd213XYmhUU6pc3G',
  decimals: 6, enableMainnet: false, faucetEnabled: true, tokenName: 'AgentBond Demo USD',
});
function required(value: string | undefined, field: string): string {
  if (!value || value.trim() !== value) throw new Error(`Explicit ${field} is required`);
  return value;
}
function address(value: string, field: string): string {
  try { const parsed=new PublicKey(value); if (parsed.equals(PublicKey.default) || parsed.toBase58() !== value) throw new Error(); }
  catch { throw new Error(`Invalid ${field} public key`); }
  return value;
}
function rpcUrl(value: string, local: boolean): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid RPC URL'); }
  if (url.username || url.password || url.hash || url.search) throw new Error('RPC URL must not contain credentials, query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local ? !loopback || !['http:', 'https:'].includes(url.protocol) : loopback || url.protocol !== 'https:') {
    throw new Error(local ? 'Localnet requires a loopback HTTP(S) RPC' : 'Public networks require a non-loopback HTTPS RPC');
  }
  return url.toString().replace(/\/$/, '');
}
/** Devnet identities are fixed. Other networks never inherit these identities. */
export function resolveNetworkProfile(input: NetworkConfig): NetworkProfile {
  if (!input || !['devnet', 'localnet', 'mainnet-beta'].includes(input.network)) throw new Error('Unsupported network profile');
  if (input.network === 'devnet') {
    for (const field of ['genesisHash', 'programId', 'mint', 'verifier', 'decimals'] as const) {
      if (input[field] !== undefined && input[field] !== DEVNET_PROFILE[field]) throw new Error(`Devnet ${field} does not match the deployed profile`);
    }
    if (input.enableMainnet) throw new Error('Mainnet enable cannot be applied to devnet');
    return Object.freeze({ ...DEVNET_PROFILE, rpcUrl: rpcUrl(input.rpcUrl ?? DEVNET_PROFILE.rpcUrl, false) });
  }
  const mainnet = input.network === 'mainnet-beta';
  if (mainnet && input.enableMainnet !== true) throw new Error('Mainnet is disabled; explicit enableMainnet is required');
  if (!mainnet && input.enableMainnet) throw new Error('Mainnet enable cannot be applied to localnet');
  const genesisHash = required(input.genesisHash, 'genesisHash');
  // A genesis hash is 32 bytes in base58; unlike an account key it may be all zero.
  try { new PublicKey(genesisHash); } catch { throw new Error('Invalid genesis hash'); }
  if (mainnet ? genesisHash !== NETWORK_GENESIS['mainnet-beta'] : (Object.values(NETWORK_GENESIS) as string[]).includes(genesisHash)) throw new Error('Genesis hash does not match the network profile');
  const programId = address(required(input.programId, 'programId'), 'programId');
  const mint = address(required(input.mint, 'mint'), 'mint');
  const verifier = address(required(input.verifier, 'verifier'), 'verifier');
  const devnetIdentities=[DEVNET_PROFILE.programId,DEVNET_PROFILE.mint,DEVNET_PROFILE.verifier];
  if (mainnet && [programId,mint,verifier].some(value=>devnetIdentities.includes(value))) throw new Error('Mainnet requires its own program, mint and verifier; devnet identities are forbidden');
  if (!Number.isInteger(input.decimals) || input.decimals! < 0 || input.decimals! > 18) throw new Error('Explicit token decimals from 0 to 18 are required');
  return Object.freeze({ network: input.network as NetworkName, rpcUrl: rpcUrl(required(input.rpcUrl, 'rpcUrl'), !mainnet), genesisHash, programId, mint, verifier, decimals: input.decimals!, enableMainnet: mainnet, faucetEnabled: !mainnet, tokenName: mainnet ? 'Configured SPL token (no freeze authority)' : 'Local demo token' });
}
/** No mainnet default, RPC alias, or devnet identity fallback is accepted. */
export function networkProfileFromEnv(env: Readonly<Record<string, string | undefined>>): NetworkProfile {
  if (env.AGENTBOND_ENABLE_MAINNET !== undefined && !['true', 'false'].includes(env.AGENTBOND_ENABLE_MAINNET)) throw new Error('AGENTBOND_ENABLE_MAINNET must be true or false');
  const decimalText = env.AGENTBOND_DECIMALS;
  if (decimalText !== undefined && !/^(0|[1-9][0-9]*)$/.test(decimalText)) throw new Error('Invalid AGENTBOND_DECIMALS');
  return resolveNetworkProfile({ network: required(env.AGENTBOND_NETWORK, 'AGENTBOND_NETWORK'), rpcUrl: env.AGENTBOND_RPC_URL, programId: env.AGENTBOND_PROGRAM_ID, mint: env.AGENTBOND_MINT, verifier: env.AGENTBOND_VERIFIER, genesisHash: env.AGENTBOND_GENESIS_HASH, decimals: decimalText === undefined ? undefined : Number(decimalText), enableMainnet: env.AGENTBOND_ENABLE_MAINNET === 'true' });
}
export function assertNetworkGenesis(profile: NetworkProfile, actual: string): void {
  const resolved = resolveNetworkProfile(profile);
  if (actual !== resolved.genesisHash) throw new Error(`RPC genesis mismatch for ${resolved.network}; signing and chain writes are disabled`);
}
export async function verifyNetworkGenesis(profile: NetworkProfile, rpc: { getGenesisHash(): Promise<string> }): Promise<void> {
  resolveNetworkProfile(profile);
  assertNetworkGenesis(profile, await rpc.getGenesisHash());
}
export function assertFaucetAllowed(profile: NetworkProfile): void {
  const resolved = resolveNetworkProfile(profile);
  if (resolved.network === 'mainnet-beta' || !resolved.faucetEnabled) throw new Error('Faucets are disabled on mainnet');
}
export function explorerUrl(profile: NetworkProfile, value: string, kind: 'address' | 'tx' = 'address'): string {
  const resolved = resolveNetworkProfile(profile);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error('Invalid Explorer identifier');
  const base = `https://explorer.solana.com/${kind}/${value}`;
  return resolved.network === 'mainnet-beta' ? base : resolved.network === 'devnet' ? `${base}?cluster=devnet` : `${base}?cluster=custom&customUrl=${encodeURIComponent(resolved.rpcUrl)}`;
}
