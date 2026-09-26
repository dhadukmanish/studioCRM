import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { accountDetailFor, normalizeGroupName, type HeadGroup } from './enums.js';

/**
 * Receipts — money received against saved bills (docs/RECEIPTS_PAYMENTS.md).
 *
 * Operational receivables only: a Receipt records that the studio was paid and which bills that
 * money settles. Nothing here posts a journal, a ledger entry or GST accounting — a later
 * accounting phase posts FROM these rows once its account mappings are decided.
 *
 * The rules every screen and the API share:
 *
 *  - A bill's Paid is the sum of its allocations on ACTIVE receipts, and its Outstanding is its
 *    Grand Total minus that. Neither is stored anywhere — the allocations are the only truth.
 *  - A receipt's amount is what was received. What it puts against bills when it is saved are its
 *    allocations; anything more is ADVANCE (docs/ADVANCE_PAYMENTS.md), which stays on the receipt,
 *    reduces no bill, and is later APPLIED to a bill (`advance_applications`) by an explicit action.
 *    Received = Allocated + Applied + Available — Available is derived, never stored.
 *  - "Credit" is not a payment mode: a bill sold on credit simply has no receipt yet.
 *  - Money is compared in whole paise, never as floats.
 */

/* ------------------------------------------------------------------- money -- */

/** A 2-decimal rupee figure as exact integer paise. */
export const toPaise = (rupees: number | string) => Math.round(Number(rupees) * 100);
/** Integer paise back to a 2-decimal rupee number. */
export const fromPaise = (paise: number) => paise / 100;

/** Ceiling of the `numeric(16, 2)` receipt columns — far past any studio receipt, and exact in paise. */
export const RECEIPT_AMOUNT_MAX = 999999999999.99;

/* ------------------------------------------------------------ payment state -- */

/**
 * A bill's payment state, derived — never stored.
 *
 *   Outstanding = 0          -> PAID            (a zero-total bill has nothing due, so it is PAID)
 *   Paid = 0                 -> UNPAID
 *   otherwise                -> PARTIALLY_PAID
 *
 * Paid above the Grand Total is an invariant violation the server prevents; it is reported as
 * PAID here rather than inventing a fourth state for something that cannot happen.
 */
export const BILL_PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
export type BillPaymentStatus = (typeof BILL_PAYMENT_STATUSES)[number];
export const BILL_PAYMENT_STATUS_LABELS: Record<BillPaymentStatus, string> = { UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid' };

export function billPaymentStatus(grandTotal: number, paid: number): BillPaymentStatus {
  const due = toPaise(grandTotal) - toPaise(paid);
  if (due <= 0) return 'PAID';
  return toPaise(paid) === 0 ? 'UNPAID' : 'PARTIALLY_PAID';
}

/* ----------------------------------------------------------- payment modes -- */

/**
 * How the money came in. Both need a real account from Account Master: CASH a cash account,
 * BANK a bank account. CREDIT is deliberately absent — it means no money was received, so it is
 * not a receipt at all.
 */
export const PAYMENT_MODES = ['CASH', 'BANK'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = { CASH: 'Cash', BANK: 'Bank' };

/**
 * Which payment mode an account may receive money for, from its Account Group — the
 * classification Account Master already keeps, never an account's name:
 *
 *   BANK  the group that drives the Bank Details block (group name BANK)
 *   CASH  a group filed under the CASH head group, or named CASH
 *
 * Anything else (customer, employee, expense, loan, partner, ...) is not a payment account.
 */
export function paymentModeForGroup(group: { groupName: string; headGroup: HeadGroup | string }): PaymentMode | null {
  if (accountDetailFor(group.groupName)?.kind === 'bank') return 'BANK';
  if (group.headGroup === 'CASH' || normalizeGroupName(group.groupName) === 'CASH') return 'CASH';
  return null;
}

/* ---------------------------------------------------------- receipt status -- */

/** A receipt is never deleted: a wrong one is CANCELLED, and its allocations then stop counting. */
export const RECEIPT_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = { ACTIVE: 'Active', CANCELLED: 'Cancelled' };

/* ----------------------------------------------------------------- schemas -- */

export const RECEIPT_LIMITS = { remark: 500, cancelReason: 250, maxAllocations: 100, customerName: 120 } as const;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const optionalText = (label: string, max: number) =>
  z.preprocess((v) => (isBlank(v) ? null : v), z.string().trim().max(max, `${label} cannot exceed ${max} characters`).nullable());

/** Positive money with at most 2 decimals. "500.50" coerces; blank never becomes 0. */
const positiveAmount = (label: string) =>
  z.preprocess(
    (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined),
    z
      .number({ required_error: `${label} is required`, invalid_type_error: `${label} is required` })
      .finite(`${label} is required`)
      .max(RECEIPT_AMOUNT_MAX, `${label} is too large`)
      .refine((n) => n > 0, `${label} must be greater than 0`)
      .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), `${label} can have at most 2 decimal places`),
  );

/**
 * Money received WITH a new bill — the bill form's Advance box. Not a bill field: the server turns it
 * into an ordinary receipt (numbered, account-checked, audited) put against that bill, inside the
 * bill's own create transaction, so the bill and the money are saved together or not at all. The
 * bill's Grand Total never changes; its Paid does. Only a NEW bill carries it — once saved, money
 * is received, cancelled or reversed through receipts, never by editing the bill.
 */
export const billAdvanceSchema = z.object({
  amount: positiveAmount('Advance'),
  paymentMode: z.enum(PAYMENT_MODES, { errorMap: () => ({ message: 'Choose Cash or Bank' }) }),
  accountId: z.string({ required_error: 'Account is required', invalid_type_error: 'Account is required' }).min(1, 'Account is required').uuid('Select a valid account'),
});
export type BillAdvanceInput = z.infer<typeof billAdvanceSchema>;

/**
 * One payment against ONE bill, in paise: up to the bill's due goes on the bill, anything beyond is
 * the customer's advance, and what the bill still owes after it. The one rule for money received
 * with a new bill (`createBill`) and for the screens that preview it — the server decides under lock.
 */
export function splitPayment(receivedPaise: number, duePaise: number) {
  const toBill = Math.max(0, Math.min(receivedPaise, duePaise));
  return { toBill, toAdvance: Math.max(0, receivedPaise - toBill), stillDue: Math.max(0, duePaise - toBill) };
}

export const receiptAllocationSchema = z.object({
  billId: z.string({ required_error: 'Bill is required', invalid_type_error: 'Bill is required' }).uuid('Select a valid bill'),
  amount: positiveAmount('Amount'),
});
export type ReceiptAllocationInput = z.infer<typeof receiptAllocationSchema>;

/**
 * A new receipt ("Receive Payment"). The client names the customer (by mobile, the key every bill
 * of theirs shares), the account, the amount received and how much of it goes to which bill. It
 * never sends a receipt number or a bill's outstanding — the server reads those itself, under lock.
 *
 * `amount` may exceed the allocations; the difference is the customer's ADVANCE. With no
 * allocations at all the whole receipt is an advance — money received before any bill exists.
 * `customerName` is used only for a customer with no bill yet; otherwise their latest bill names them.
 */
export const receiptSchema = z
  .object({
    receiptDate: z
      .string({ required_error: 'Receipt date is required', invalid_type_error: 'Receipt date is required' })
      .trim()
      .refine(isIsoDate, 'Enter a valid receipt date'),
    customerMobile: z.string({ required_error: 'Customer is required', invalid_type_error: 'Customer is required' }).trim().min(1, 'Customer is required').max(30, 'Customer is required'),
    paymentMode: z.enum(PAYMENT_MODES, { errorMap: () => ({ message: 'Choose Cash or Bank' }) }),
    accountId: z.string({ required_error: 'Account is required', invalid_type_error: 'Account is required' }).min(1, 'Account is required').uuid('Select a valid account'),
    amount: positiveAmount('Receipt amount'),
    remark: optionalText('Remark', RECEIPT_LIMITS.remark),
    customerName: optionalText('Customer name', RECEIPT_LIMITS.customerName),
    allocations: z
      .array(receiptAllocationSchema, { invalid_type_error: 'Allocations must be a list' })
      .max(RECEIPT_LIMITS.maxAllocations, `A receipt can settle at most ${RECEIPT_LIMITS.maxAllocations} bills`)
      .default([]),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.allocations.forEach((a, i) => {
      if (seen.has(a.billId)) ctx.addIssue({ code: 'custom', path: ['allocations', i, 'billId'], message: 'This bill is already in the receipt' });
      seen.add(a.billId);
    });
    const allocated = v.allocations.reduce((s, a) => s + toPaise(a.amount), 0);
    if (allocated > toPaise(v.amount)) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'The amount received cannot be less than the total put against bills' });
  });
export type ReceiptInput = z.infer<typeof receiptSchema>;

/**
 * Apply a customer's available advance to one of their bills. The amount is explicit — never
 * applied silently; the screen proposes min(available advance, outstanding). The server takes the
 * money from the customer's oldest advances first, under lock.
 */
export const applyAdvanceSchema = z.object({
  billId: z.string({ required_error: 'Bill is required', invalid_type_error: 'Bill is required' }).uuid('Select a valid bill'),
  amount: positiveAmount('Amount'),
});
export type ApplyAdvanceInput = z.infer<typeof applyAdvanceSchema>;

/** Reverse an applied advance: the money goes back to the customer's available advance. */
export const reverseApplicationSchema = z.object({ reason: optionalText('Reason', RECEIPT_LIMITS.cancelReason) });

export const receiptCancelSchema = z.object({ reason: optionalText('Reason', RECEIPT_LIMITS.cancelReason) });
export type ReceiptCancelInput = z.infer<typeof receiptCancelSchema>;

/* ------------------------------------------------------------ API shapes -- */

/** A bill's payment position. Every figure is derived by the server from ACTIVE allocations. */
export interface BillPaymentPosition {
  grandTotal: number;
  paidAmount: number;
  outstandingAmount: number;
  paymentStatus: BillPaymentStatus;
}

/** A bill a receipt may settle — GET /api/receipts/pending-bills. Oldest first. */
export interface PendingBill extends BillPaymentPosition {
  id: string;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  customerName: string;
}

/** A customer, keyed by the normalized mobile every bill of theirs carries — GET /api/receipts/customers. */
export interface ReceivableCustomer {
  /** The normalized mobile (`bills.mobile_search`) — what a receipt sends as `customerMobile`. */
  customerKey: string;
  /** Name and mobile as their most recent bill has them. */
  customerName: string;
  mobileNumber: string;
  billCount: number;
  pendingBillCount: number;
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
}

/** A payment account the operator may pick — GET /api/receipts/accounts?mode=CASH|BANK. */
export interface PaymentAccountOption {
  id: string;
  accountName: string;
  groupName: string;
}

export interface ReceiptRow {
  id: string;
  receiptNumber: number;
  receiptDate: string;
  customerName: string;
  mobileNumber: string;
  paymentMode: PaymentMode;
  accountId: string;
  accountName: string;
  amount: number;
  /** Put against bills: allocations plus ACTIVE advance applications. */
  appliedAmount: number;
  /** Advance still available: amount - applied while ACTIVE, 0 once cancelled. Derived, never stored. */
  availableAmount: number;
  remark: string | null;
  status: ReceiptStatus;
  /** "Book/Bill" of every bill it settles (allocations and applied advance) — for the list and its search. */
  billNumbers: string;
  createdByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptAllocationRow extends BillPaymentPosition {
  id: string;
  billId: string;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  /** What THIS receipt put against the bill. The position fields above are the bill's as of now. */
  amount: number;
}

/** An advance applied from a receipt to a bill. REVERSED ones stay listed and stop counting. */
export const ADVANCE_APPLICATION_STATUSES = ['ACTIVE', 'REVERSED'] as const;
export type AdvanceApplicationStatus = (typeof ADVANCE_APPLICATION_STATUSES)[number];

export interface AdvanceApplicationRow {
  id: string;
  billId: string;
  bookNumber: string;
  billNumber: number;
  appliedOn: string;
  amount: number;
  status: AdvanceApplicationStatus;
  reversedAt: string | null;
  reverseReason: string | null;
}

export interface ReceiptRecord extends ReceiptRow {
  allocations: ReceiptAllocationRow[];
  /** What the receipt kept as advance when it was saved: amount - allocations. (Some may be applied since.) */
  advanceAmount: number;
  /** Advance from this receipt applied to bills later — reversed ones included, marked so. */
  applications: AdvanceApplicationRow[];
}

/**
 * One line in a bill's payment history: money a receipt put on it when saved (RECEIPT), or advance
 * applied to it later (ADVANCE). Cancelled receipts and reversed applications stay listed.
 */
export interface BillPaymentHistoryRow {
  kind: 'RECEIPT' | 'ADVANCE';
  receiptId: string;
  receiptNumber: number;
  /** The receipt date, or the date the advance was applied. */
  date: string;
  paymentMode: PaymentMode;
  accountName: string;
  amount: number;
  /** Counts towards Paid only while true: an ACTIVE receipt (and, for ADVANCE, an ACTIVE application). */
  counts: boolean;
  status: ReceiptStatus;
  /** ADVANCE rows only. */
  applicationId: string | null;
  applicationStatus: AdvanceApplicationStatus | null;
}

/** GET /api/bills/:id/payments */
export interface BillPayments extends BillPaymentPosition {
  history: BillPaymentHistoryRow[];
  /** The bill's customer's advance not yet applied anywhere. */
  availableAdvance: number;
  /** What "Apply Advance" proposes: min(available advance, outstanding). 0 = nothing to apply. */
  advanceToApply: number;
}

/** GET /api/receipts/advance?customer= — a customer's available advance, oldest receipt first. */
export interface CustomerAdvance {
  customerKey: string;
  availableAdvance: number;
  receipts: { id: string; receiptNumber: number; receiptDate: string; amount: number; availableAmount: number }[];
}
