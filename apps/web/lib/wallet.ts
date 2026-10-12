import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { Config } from './types';
import {resolveNetworkProfile,assertNetworkGenesis} from '../../../packages/shared/src/network';
import {rpcConnection,rpcIdentity} from './rpc';
import type {AgentBondClient} from '../../../packages/sdk/src/index';
export type InjectedWallet = {
  isPhantom?: boolean; isSolflare?: boolean; publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect?: () => Promise<void>;
  on?: (event:string,listener:(value?:unknown)=>void)=>void;
  off?: (event:string,listener:(value?:unknown)=>void)=>void;
  removeListener?: (event:string,listener:(value?:unknown)=>void)=>void;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(tx: T[]) => Promise<T[]>;
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
};
declare global { interface Window { solana?: InjectedWallet; phantom?: { solana: InjectedWallet }; solflare?: InjectedWallet } }
export function injected() { return window.phantom?.solana ?? window.solflare ?? window.solana; }
// Solana upstream sdk/src/genesis_config.rs: compare full genesis hashes, not CAIP-2 prefixes.
const genesisHashes = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
export function validateGenesis(config: Config, genesis: string) {
  if(config.network==='mainnet-beta'){const profile=resolveNetworkProfile({...config,verifier:config.designatedVerifier??config.defaultVerifier??config.verifier});assertNetworkGenesis(profile,genesis);return}
  if (genesis === genesisHashes.mainnet) throw new Error('Mainnet signing is disabled.');
  if (config.network === 'localnet') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.rpcUrl).hostname)) throw new Error('Localnet requires a loopback RPC URL.');
    if (Object.values(genesisHashes).includes(genesis)) throw new Error('Wrong network: RPC does not match localnet.');
  } else if (config.network !== 'devnet' && config.network !== 'testnet') {
    throw new Error('Unsupported AgentBond network profile.');
  } else if (genesis !== genesisHashes[config.network]) {
    throw new Error('Wrong network: RPC genesis hash does not match the configured test network.');
  }
}
export {validateChallenge,type Challenge,type AuthAction} from '../../../packages/shared/src/wallet-auth';
const clients=new WeakMap<InjectedWallet,Map<string,Promise<AgentBondClient>>>();
export async function client(config: Config, wallet: InjectedWallet) {
  if (!wallet.publicKey) throw new Error('Connect your wallet before signing.');
  if (!['localnet', 'devnet', 'testnet','mainnet-beta'].includes(config.network)) throw new Error('Unsupported AgentBond network profile.');
  if(config.writesEnabled===false)throw new Error('Wallet transactions are disabled until the hosted service is ready.');
  const profile=['devnet','mainnet-beta'].includes(config.network)?resolveNetworkProfile({...config,verifier:config.designatedVerifier??config.defaultVerifier??config.verifier}):undefined;
  const connection=rpcConnection(config);validateGenesis(config,await connection.getGenesisHash());
  let cache=clients.get(wallet);if(!cache){cache=new Map();clients.set(wallet,cache)}const identity=rpcIdentity(config);let sdk=cache.get(identity);
  if(!sdk){sdk=import('../../../packages/sdk/src/index').then(({AgentBondClient})=>new AgentBondClient(connection,{publicKey:wallet.publicKey!,signTransaction:wallet.signTransaction.bind(wallet),signAllTransactions:wallet.signAllTransactions.bind(wallet)},new PublicKey(config.programId),{networkProfile:profile}));cache.set(identity,sdk);sdk.catch(()=>cache!.delete(identity));}
  return {sdk:await sdk,connection};
}
export async function tokenAccount(config: Config, wallet: InjectedWallet) {
  if (!wallet.publicKey) throw new Error('Connect a wallet.');
  return getAssociatedTokenAddress(new PublicKey(config.mint), wallet.publicKey);
}
export function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|4001/i.test(message)) return 'Signature rejected. No new transaction was authorized.';
  if (/insufficient|no record of a prior credit|Attempt to debit/i.test(message)) return 'Insufficient SOL or configured token balance. Fund this wallet on the configured network.';
  if (/429|rate.limit|Too Many Requests/i.test(message)) return 'The RPC provider is rate limited. Wait briefly, then retry with this wallet; avoid creating a duplicate job.';
  if (/blockhash|network|Failed to fetch|fetch failed/i.test(message)) return 'Network unavailable or wallet network mismatch. Select the configured network and retry.';
  return message;
}
