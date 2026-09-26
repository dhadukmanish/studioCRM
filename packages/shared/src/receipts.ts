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
 *  - A receipt's amount is exactly the sum of its allocations. Nothing is left unallocated
 *    (customer advances are a later, separate decision).
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

export const RECEIPT_LIMITS = { remark: 500, cancelReason: 250, maxAllocations: 100 } as const;

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

export const receiptAllocationSchema = z.object({
  billId: z.string({ required_error: 'Bill is required', invalid_type_error: 'Bill is required' }).uuid('Select a valid bill'),
  amount: positiveAmount('Amount'),
});
export type ReceiptAllocationInput = z.infer<typeof receiptAllocationSchema>;

/**
 * A new receipt. The client names the customer (by mobile, the key every bill of theirs shares),
 * the account, and how much goes to which bill. It never sends a receipt number, a customer name
 * or a bill's outstanding — the server reads those itself, under lock.
 *
 * `amount` is what the operator sees as the receipt total; it must equal the allocations to the
 * paisa, so money can never be left floating.
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
    allocations: z
      .array(receiptAllocationSchema, { required_error: 'Allocate the amount to at least one bill', invalid_type_error: 'Allocate the amount to at least one bill' })
      .min(1, 'Allocate the amount to at least one bill')
      .max(RECEIPT_LIMITS.maxAllocations, `A receipt can settle at most ${RECEIPT_LIMITS.maxAllocations} bills`),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.allocations.forEach((a, i) => {
      if (seen.has(a.billId)) ctx.addIssue({ code: 'custom', path: ['allocations', i, 'billId'], message: 'This bill is already in the receipt' });
      seen.add(a.billId);
    });
    const allocated = v.allocations.reduce((s, a) => s + toPaise(a.amount), 0);
    if (allocated !== toPaise(v.amount)) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'The receipt amount must equal the total allocated to bills' });
  });
export type ReceiptInput = z.infer<typeof receiptSchema>;

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
  remark: string | null;
  status: ReceiptStatus;
  /** "Book/Bill" of every bill it settles, in allocation order — for the list and its search. */
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

export interface ReceiptRecord extends ReceiptRow {
  allocations: ReceiptAllocationRow[];
}

/** One receipt line in a bill's payment history — cancelled ones included, marked as such. */
export interface BillPaymentHistoryRow {
  receiptId: string;
  receiptNumber: number;
  receiptDate: string;
  paymentMode: PaymentMode;
  accountName: string;
  amount: number;
  status: ReceiptStatus;
}

/** GET /api/bills/:id/payments */
export interface BillPayments extends BillPaymentPosition {
  history: BillPaymentHistoryRow[];
}
