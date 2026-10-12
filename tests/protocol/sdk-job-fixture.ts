import BN from 'bn.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { AgentBondClient, JobAccount } from '../../packages/sdk/src/index.ts';
import { DEVNET_PROFILE } from '../../packages/shared/src/network.ts';

/** Real Anchor Borsh bytes at a canonical address; no chain or signing effects. */
export async function encodedJob(client:AgentBondClient,overrides:Partial<JobAccount>={}) {
  const creator=new PublicKey('8PKHbcjhYNA2aSiEeVxABP84Y9F1JQnkExLR6uEYFLFC'),id=new BN(1);
  const [address,bump]=PublicKey.findProgramAddressSync([new TextEncoder().encode('job'),(overrides.creator??creator).toBytes(),(overrides.id??id).toArrayLike(Buffer,'le',8)],client.programId);
  const [vault,vaultBump]=PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'),address.toBytes()],client.programId);
  const data:JobAccount={id,creator,worker:new PublicKey('2rZn66HSqiZ4hmYxosiLD4uH1va4vW37KWDuc5WNPQyw'),verifier:new PublicKey(DEVNET_PROFILE.verifier),mint:new PublicKey(DEVNET_PROFILE.mint),tokenProgram:TOKEN_PROGRAM_ID,vault,bump,vaultBump,amount:new BN(25),specHash:new Array(32).fill(1),acceptanceHash:new Array(32).fill(2),artifactHash:new Array(32).fill(3),verificationHash:new Array(32).fill(4),createdAt:new BN(1),fundedAt:new BN(2),claimedAt:new BN(3),submittedAt:new BN(4),verifiedAt:new BN(5),settledAt:new BN(6),claimDeadline:new BN(7),submitDeadline:new BN(8),verifyDeadline:new BN(9),status:{settled:{}},...overrides};
  const bytes=await client.program.coder.accounts.encode('job',data);
  const info:AccountInfo<Buffer>={owner:client.programId,data:bytes,executable:false,lamports:1,rentEpoch:0};
  return {address,data,info};
}
