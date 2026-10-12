import {describe,it,expect} from 'vitest';
import {budgetUnits,csvPreview,refundAvailable} from '../../apps/web/lib/workflow';
import type {ChainJob} from '../../apps/web/lib/types';
describe('CSV selection before signed upload',()=>{
 it('handles quoted fields, CRLF and finite numeric columns',()=>{expect(csvPreview('label,revenue,orders\r\n"North, East",120,4\r\n"South ""West""",1.8e3,6\r\n')).toEqual({headers:['label','revenue','orders'],numericColumns:['revenue','orders'],rowCount:2})});
 it('rejects malformed or unsupported data before wallet authorization',()=>{for(const input of ['a,a\n1,2\n','a,b\n1\n','a\n"bad\n','name\nhello\n','n\nInfinity\n','n\n1000000000001\n'])expect(()=>csvPreview(input)).toThrow();expect(()=>csvPreview('n\n'+'1\n'.repeat(10001))).toThrow();expect(()=>csvPreview('n\n'+'1'.repeat(1024*1024))).toThrow()});
});
describe('exact escrow budgets',()=>{
 it('keeps integer precision beyond Number and handles six decimals',()=>{expect(budgetUnits('25.000001',6)).toBe(25000001n);expect(budgetUnits('9007199254.740993',6)).toBe(9007199254740993n)});
 it('rejects zero, exponent notation, excess precision and u64 overflow',()=>{for(const value of ['0','1e2','-1','0.0000001','18446744073709551616'])expect(()=>budgetUnits(value,6)).toThrow()});
});
describe('creator refund eligibility',()=>{
 const job={claimDeadline:100,submitDeadline:200,verifyDeadline:300} as ChainJob;
 it('uses rejection or the exact applicable deadline',()=>{expect(refundAvailable({...job,status:'FUNDED'},99)).toBe(false);expect(refundAvailable({...job,status:'FUNDED'},100)).toBe(true);expect(refundAvailable({...job,status:'CLAIMED'},199)).toBe(false);expect(refundAvailable({...job,status:'SUBMITTED'},300)).toBe(true);expect(refundAvailable({...job,status:'REJECTED'},1)).toBe(true);for(const status of ['CREATED','VERIFIED','SETTLED','REFUNDED'])expect(refundAvailable({...job,status},1000)).toBe(false)});
});
