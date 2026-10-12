import { describe, expect, it } from 'vitest';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { isExpectedAnchorError, tokenBalanceSnapshot } from '../../packages/agent-runtime/src/chain-evidence.ts';

describe('confirmed transaction evidence', () => {
  const recipient = PublicKey.unique().toBase58(), vault = PublicKey.unique().toBase58(), mint = PublicKey.unique().toBase58();
  function transaction() {
    const entries = (recipientAmount: string, vaultAmount: string) => [recipientAmount, vaultAmount].map((amount,index) => ({ accountIndex: index, mint, uiTokenAmount: { amount } }));
    return { meta: { err: null, preTokenBalances: entries('100', '25'), postTokenBalances: entries('125', '0') }, transaction: { message: { getAccountKeys: () => ({ get: (index: number) => new PublicKey([recipient,vault][index]) }) } } } as unknown as VersionedTransactionResponse;
  }
  it('extracts per-transaction exact balances independent of current shared wallet balance', () => {
    expect(tokenBalanceSnapshot(transaction(), { recipient, vault }, mint)).toEqual({ recipientBefore: '100', recipientAfter: '125', vaultBefore: '25', vaultAfter: '0' });
  });
  it('refuses failed transactions, missing balance records and substituted mint/accounts', () => {
    const failed = transaction(); failed.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    expect(() => tokenBalanceSnapshot(failed, { recipient, vault }, mint)).toThrow('failed');
    expect(() => tokenBalanceSnapshot(transaction(), { recipient, vault }, PublicKey.unique().toBase58())).toThrow('Missing');
    expect(() => tokenBalanceSnapshot(transaction(), { recipient: PublicKey.unique().toBase58(), vault }, mint)).toThrow('Missing');
    const missing = transaction(); missing.meta!.postTokenBalances = []; expect(() => tokenBalanceSnapshot(missing, { recipient, vault }, mint)).toThrow('Missing');
  });
  it('counts only the expected Anchor program rejection as duplicate-transfer prevention', () => {
    expect(isExpectedAnchorError(new Error('RPC offline: InvalidState'), 'InvalidState')).toBe(false);
    expect(isExpectedAnchorError({ error: { errorCode: { code: 'InvalidState', number: 6005 } } }, 'InvalidState')).toBe(true);
    expect(isExpectedAnchorError({ error: { errorCode: { code: 'InvalidState', number: 6009 } } }, 'InvalidState')).toBe(false);
    expect(isExpectedAnchorError({ logs: ['Program log: AnchorError. Error Code: RefundUnavailable. Error Number: 6009. Error Message: not refundable'] }, 'RefundUnavailable')).toBe(true);
  });
});
