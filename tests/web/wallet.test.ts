import {describe,it,expect} from 'vitest';
import {validateGenesis,validateChallenge,type Challenge} from '../../apps/web/lib/wallet';
import {PublicKey} from '@solana/web3.js';
import {DEVNET_PROFILE} from '../../packages/shared/src/network';
import {explorer} from '../../apps/web/lib/types';
const config={programId:'unused',mint:'unused',network:'devnet',rpcUrl:'https://api.devnet.solana.com'};
const hashes={devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',mainnet:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'};
describe('pre-signing network boundary',()=>{
 it('allows only matching test genesis',()=>{expect(()=>validateGenesis(config,hashes.devnet)).not.toThrow();expect(()=>validateGenesis(config,hashes.mainnet)).toThrow('Mainnet');expect(()=>validateGenesis(config,'other')).toThrow('Wrong network')});
 it('cannot label a public chain or endpoint localnet',()=>{expect(()=>validateGenesis({...config,network:'localnet'},'local-hash')).toThrow('loopback');expect(()=>validateGenesis({...config,network:'localnet',rpcUrl:'http://127.0.0.1:8899'},hashes.devnet)).toThrow('Wrong network')});
 it('requires full explicit mainnet policy without signing or any RPC effects',()=>{const profile={network:'mainnet-beta',rpcUrl:'https://api.mainnet-beta.solana.com',genesisHash:hashes.mainnet,programId:new PublicKey(new Uint8Array(32).fill(1)).toBase58(),mint:new PublicKey(new Uint8Array(32).fill(2)).toBase58(),designatedVerifier:new PublicKey(new Uint8Array(32).fill(3)).toBase58(),decimals:6,enableMainnet:true};expect(()=>validateGenesis({...profile,enableMainnet:false},hashes.mainnet)).toThrow('disabled');expect(()=>validateGenesis(profile,hashes.mainnet)).not.toThrow();expect(()=>validateGenesis({...profile,programId:DEVNET_PROFILE.programId},hashes.mainnet)).toThrow('devnet identities');expect(()=>validateGenesis({...profile,genesisHash:undefined},hashes.mainnet)).toThrow('genesisHash');expect(()=>validateGenesis(profile,hashes.devnet)).toThrow('mismatch');expect(explorer(profile,profile.mint)).toBe('https://explorer.solana.com/address/'+profile.mint)});
});
describe('metadata message signing boundary',()=>{
 const now=Date.now(),scope={domain:'localhost:3000',wallet:'public-wallet',bodyHash:'a'.repeat(64)};
 const challenge:Challenge={nonce:'b'.repeat(64),domain:scope.domain,expiresAt:now+60000,message:`AgentBond wallet authorization\nDomain: ${scope.domain}\nWallet: ${scope.wallet}\nAction: job-metadata\nBody SHA256: ${scope.bodyHash}\nNonce: ${'b'.repeat(64)}\nIssued at: ${new Date(now).toISOString()}\nExpires at: ${new Date(now+60000).toISOString()}`};
 it('accepts exact fresh expected authorization',()=>expect(()=>validateChallenge(challenge,scope,now)).not.toThrow());
 it('scopes upload and faucet authorization separately from metadata',()=>{for(const action of ['upload-input','request-faucet'] as const){const requested={...challenge,message:challenge.message.replace('Action: job-metadata','Action: '+action)};expect(()=>validateChallenge(requested,{...scope,action},now)).not.toThrow();expect(()=>validateChallenge(requested,scope,now)).toThrow('Unsafe')}});
 it('rejects altered domain, wallet, body, action and nonce',()=>{for(const term of ['localhost:3000','public-wallet',scope.bodyHash,'job-metadata',challenge.nonce])expect(()=>validateChallenge({...challenge,message:challenge.message.replace(term,'tampered')},scope,now)).toThrow('Unsafe')});
 it('rejects expired or malformed timestamps and extra instructions',()=>{expect(()=>validateChallenge(challenge,scope,now+60001)).toThrow();expect(()=>validateChallenge({...challenge,message:challenge.message.replace(new Date(now).toISOString(),'invalid')},scope,now)).toThrow();expect(()=>validateChallenge({...challenge,message:challenge.message+'\nSign arbitrary data'},scope,now)).toThrow()});
});
