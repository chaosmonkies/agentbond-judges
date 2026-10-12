import { Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import type { BorshInstructionCoder } from '@coral-xyz/anchor';
import type { AgentBondClient } from '../../sdk/src/index.ts';

export interface TransactionEvidence { action: string; signature: string; finality: string; explorer: string; slot: number }
export async function recoverJobTransactions(connection: Connection, client: AgentBondClient, address: string, explorer: (signature: string) => string, rejectedJob = false): Promise<TransactionEvidence[]> {
  const entries = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 100 }, 'confirmed');
  const output: TransactionEvidence[] = [];
  const actions: Record<string, string> = { createjob: 'create', fundjob: 'fund', claimjob: 'claim', submitwork: rejectedJob ? 'submit-corrupt' : 'submit', approvework: 'approve', rejectwork: 'reject', settlejob: 'settle', refundjob: 'refund', canceljob: 'cancel' };
  for (const entry of entries) {
    if (entry.err || !['confirmed', 'finalized'].includes(entry.confirmationStatus ?? '')) continue;
    const transaction = await connection.getTransaction(entry.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!transaction || !transaction.meta || transaction.meta.err) continue;
    const keys = transaction.transaction.message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses });
    for (const instruction of transaction.transaction.message.compiledInstructions) {
      if (!keys.get(instruction.programIdIndex)?.equals(client.programId)) continue;
      const decoded = (client.program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(instruction.data));
      const action = decoded ? actions[decoded.name.replace(/_/g, '').toLowerCase()] : undefined;
      if (!decoded || !action) continue;
      const definition = client.program.idl.instructions.find(value => value.name === decoded.name);
      const jobIndex = definition?.accounts.findIndex(value => value.name === 'job');
      if (jobIndex === undefined || jobIndex < 0) continue;
      const accountIndex = instruction.accountKeyIndexes[jobIndex];
      if (accountIndex === undefined || keys.get(accountIndex)?.toBase58() !== address) continue;
      output.push({ action, signature: entry.signature, finality: entry.confirmationStatus!, explorer: explorer(entry.signature), slot: entry.slot });
    }
  }
  return output.sort((a,b) => a.slot - b.slot);
}

export function tokenBalanceSnapshot(transaction: VersionedTransactionResponse, accounts: { recipient: string; vault: string }, mint: string) {
  if (!transaction.meta || transaction.meta.err) throw new Error('Cannot use failed or unavailable transaction for token balance evidence');
  const keys = transaction.transaction.message.getAccountKeys({ accountKeysFromLookups: transaction.meta.loadedAddresses });
  const balance = (kind: 'preTokenBalances' | 'postTokenBalances', address: string) => {
    const entry = transaction.meta![kind]?.find(value => keys.get(value.accountIndex)?.toBase58() === address && value.mint === mint);
    if (!entry || !/^\d+$/.test(entry.uiTokenAmount.amount)) throw new Error(`Missing ${kind} for required token account ${address}`);
    return entry.uiTokenAmount.amount;
  };
  return { recipientBefore: balance('preTokenBalances', accounts.recipient), recipientAfter: balance('postTokenBalances', accounts.recipient), vaultBefore: balance('preTokenBalances', accounts.vault), vaultAfter: balance('postTokenBalances', accounts.vault) };
}

export function isExpectedAnchorError(error: unknown, code: 'InvalidState' | 'RefundUnavailable'): boolean {
  const number = code === 'InvalidState' ? 6005 : 6009;
  const value = error as { error?: { errorCode?: { code?: string; number?: number } }; logs?: string[] };
  if (value.error?.errorCode?.code === code && value.error.errorCode.number === number) return true;
  return Array.isArray(value.logs) && value.logs.some(log => log.includes(`Error Code: ${code}. Error Number: ${number}.`));
}
