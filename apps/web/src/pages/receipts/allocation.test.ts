import { describe, expect, it } from 'vitest';
import { RECEIPT_LIMITS, type PendingBill } from '@erp/shared';
import { allocatedCount, allocatedPaise, autoAllocate, payAllInFull, splitPayment } from './allocation';

const bill = (i: number, outstanding: number): PendingBill => ({
  id: `b${i}`,
  bookNumber: '2026-27',
  billNumber: i,
  billDate: '2026-09-01',
  customerName: 'C',
  grandTotal: outstanding,
  paidAmount: 0,
  outstandingAmount: outstanding,
  paymentStatus: 'UNPAID',
});
const many = (n: number) => Array.from({ length: n }, (_, i) => bill(i + 1, 10));

describe('the per-receipt bill limit is never applied silently', () => {
  it('Pay all fills only the oldest 100 and reports how many were left out', () => {
    const bills = many(105);
    const r = payAllInFull(bills);
    expect(allocatedCount(bills, r.allocations)).toBe(RECEIPT_LIMITS.maxAllocations);
    expect(r.skipped).toBe(5);
    expect(Object.keys(r.allocations)).toEqual(bills.slice(0, 100).map((b) => b.id));
  });

  it('Pay all under the limit fills everything and skips nothing', () => {
    const bills = many(3);
    expect(payAllInFull(bills)).toEqual({ allocations: { b1: '10.00', b2: '10.00', b3: '10.00' }, skipped: 0 });
  });

  it('Auto allocate stops at 100 bills and reports the rest as capped, not as an advance', () => {
    const bills = many(105);
    const r = autoAllocate(bills, 105 * 1000);
    expect(allocatedCount(bills, r.allocations)).toBe(100);
    expect(allocatedPaise(bills, r.allocations)).toBe(100 * 1000);
    expect(r).toMatchObject({ leftoverPaise: 5 * 1000, capped: true });
  });

  it('Auto allocate is oldest-first and exact in paise', () => {
    const bills = [bill(1, 10000), bill(2, 5000), bill(3, 8000)];
    expect(autoAllocate(bills, 1200000)).toEqual({ allocations: { b1: '10000.00', b2: '2000.00' }, leftoverPaise: 0, capped: false });
    expect(autoAllocate(bills, 2400000)).toMatchObject({ leftoverPaise: 100000, capped: false });
  });
});

describe('splitPayment (quick Receive payment against one bill)', () => {
  it('up to Due goes on the bill; beyond Due is advance; short of Due leaves the rest due — in paise', () => {
    expect(splitPayment(500000, 500000)).toEqual({ toBill: 500000, toAdvance: 0, stillDue: 0 });
    expect(splitPayment(700000, 500000)).toEqual({ toBill: 500000, toAdvance: 200000, stillDue: 0 });
    expect(splitPayment(200001, 500000)).toEqual({ toBill: 200001, toAdvance: 0, stillDue: 299999 });
  });
  it('a bill with nothing due takes nothing — the whole amount is advance', () => {
    expect(splitPayment(100000, 0)).toEqual({ toBill: 0, toAdvance: 100000, stillDue: 0 });
  });
});
