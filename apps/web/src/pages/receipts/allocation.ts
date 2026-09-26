import { RECEIPT_LIMITS, fromPaise, toPaise, type PendingBill } from '@erp/shared';
import { fmtMoney } from '@/lib/format';

/**
 * The allocation grid's bookkeeping, in whole paise — never float rupees. Nothing here decides
 * what a bill owes (that is the server's `outstandingAmount`); it only checks what the operator
 * typed against it and adds up what will be posted. The server re-checks all of it under lock.
 */

/** What the operator typed per bill id, kept as text so "cleared" and "12." stay expressible. */
export type Allocations = Record<string, string>;

/** Up to 2 decimals, the shape the shared schema accepts. */
const MONEY = /^\d+(\.\d{1,2})?$/;

/** Typed text -> paise; blank is 0, anything unparseable is null. */
export function typedPaise(text: string | undefined): number | null {
  const v = (text ?? '').trim();
  if (v === '') return 0;
  return MONEY.test(v) ? toPaise(v) : null;
}

/** Why a row's amount cannot be saved, or null. */
export function allocationError(text: string | undefined, bill: PendingBill): string | null {
  const p = typedPaise(text);
  if (p === null) return 'Enter an amount with at most 2 decimals';
  if (p > toPaise(bill.outstandingAmount)) return `Cannot exceed the outstanding ${fmtMoney(bill.outstandingAmount)}`;
  return null;
}

export const allocatedPaise = (bills: PendingBill[], a: Allocations) => bills.reduce((s, b) => s + (typedPaise(a[b.id]) ?? 0), 0);

/** Paise back to the plain text an input shows ("1500.5" -> "1500.50"). */
export const paiseText = (p: number) => fromPaise(p).toFixed(2);

/** How many bills the typed amounts put money on — a receipt may settle at most `RECEIPT_LIMITS.maxAllocations`. */
export const allocatedCount = (bills: PendingBill[], a: Allocations) => bills.filter((b) => (typedPaise(a[b.id]) ?? 0) > 0).length;

/**
 * The oldest bills paid in full, up to the per-receipt limit. `skipped` is how many pending bills
 * did not fit, so the screen can SAY so instead of silently leaving them out.
 */
export function payAllInFull(bills: PendingBill[], max: number = RECEIPT_LIMITS.maxAllocations): { allocations: Allocations; skipped: number } {
  const taken = bills.slice(0, max);
  return { allocations: Object.fromEntries(taken.map((b) => [b.id, paiseText(toPaise(b.outstandingAmount))])), skipped: bills.length - taken.length };
}

/**
 * Spread a target over the bills OLDEST FIRST — the order the server returns them in. Each bill
 * takes min(remaining, its outstanding), so the same target always gives the same split. At most
 * `max` bills are used. Returns what could not be placed (a receipt never carries an unallocated
 * advance) and whether the bill limit, rather than the customer's total due, stopped it.
 */
export function autoAllocate(bills: PendingBill[], targetPaise: number, max: number = RECEIPT_LIMITS.maxAllocations): { allocations: Allocations; leftoverPaise: number; capped: boolean } {
  let remaining = targetPaise;
  const allocations: Allocations = {};
  let used = 0;
  for (const b of bills) {
    if (remaining <= 0) break;
    if (used === max) return { allocations, leftoverPaise: remaining, capped: true };
    const take = Math.min(remaining, toPaise(b.outstandingAmount));
    if (take > 0) {
      allocations[b.id] = paiseText(take);
      used += 1;
    }
    remaining -= take;
  }
  return { allocations, leftoverPaise: remaining, capped: false };
}


/** One payment against one bill — the shared rule (`@erp/shared`), re-exported for the receipt screens. */
export { splitPayment } from '@erp/shared';
