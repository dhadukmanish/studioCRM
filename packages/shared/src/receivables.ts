import { z } from 'zod';
import { isIsoDate } from './dates.js';
import type { BillPaymentStatus, PaymentMode, ReceiptStatus } from './receipts.js';

/**
 * Receivables / Outstanding reports (docs/RECEIVABLES_REPORTS.md).
 *
 * Read-only views over Billing + Receipts. Nothing here stores a balance: Paid is the sum of a
 * bill's allocations on ACTIVE receipts (dated on or before the As-of date), Outstanding is Grand
 * Total minus that — the Phase 6 definition, computed by the server in SQL.
 *
 * A customer is the normalized mobile (`bills.mobile_search`) — a TEMPORARY identity until a
 * Customer / Party Master exists. Two spellings of one mobile are one customer; one name on two
 * mobiles is two customers.
 */

/* ------------------------------------------------------------------ aging -- */

/**
 * Aging buckets, by whole days from the aging anchor to the As-of date.
 *
 * The anchor is the BILL DATE: bills have no due date, and none is invented. "Current" is a bill
 * dated on the As-of date itself (age 0).
 */
export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = { CURRENT: 'Current', D1_30: '1–30 days', D31_60: '31–60 days', D61_90: '61–90 days', D90_PLUS: '90+ days' };
/** Upper bound (inclusive) of each bucket in days; the last is open-ended. The SQL mirrors this. */
export const AGING_BUCKET_MAX_DAYS: Record<Exclude<AgingBucket, 'D90_PLUS'>, number> = { CURRENT: 0, D1_30: 30, D31_60: 60, D61_90: 90 };

export function agingBucket(days: number): AgingBucket {
  if (days <= AGING_BUCKET_MAX_DAYS.CURRENT) return 'CURRENT';
  if (days <= AGING_BUCKET_MAX_DAYS.D1_30) return 'D1_30';
  if (days <= AGING_BUCKET_MAX_DAYS.D31_60) return 'D31_60';
  if (days <= AGING_BUCKET_MAX_DAYS.D61_90) return 'D61_90';
  return 'D90_PLUS';
}

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"), never below 0. Computed on the digits — no timezone can shift it. */
export function ageInDays(to: string, from: string): number {
  const day = (v: string) => Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) / 86_400_000;
  return Math.max(0, day(to) - day(from));
}

/** The studio's zone, used when a company names none (or an unknown one). */
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/** "YYYY-MM-DD" today in a time zone — the business date a report defaults its As of to. */
export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const fmt = (tz: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  try {
    return fmt(timeZone);
  } catch {
    return fmt(DEFAULT_TIME_ZONE);
  }
}

/* ---------------------------------------------------------------- filters -- */

/** Which bills the Outstanding Bills report lists. OUTSTANDING (the default) = Unpaid + Partially paid. */
export const RECEIVABLE_BILL_STATUSES = ['OUTSTANDING', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'ALL'] as const;
export type ReceivableBillStatus = (typeof RECEIVABLE_BILL_STATUSES)[number];
export const RECEIVABLE_BILL_STATUS_LABELS: Record<ReceivableBillStatus, string> = { OUTSTANDING: 'Outstanding', UNPAID: 'Unpaid', PARTIALLY_PAID: 'Partially paid', PAID: 'Paid', ALL: 'All bills' };

/** The most rows one export or print carries. Past it the request is refused — never silently cut. */
export const RECEIVABLES_EXPORT_MAX_ROWS = 20_000;

const isoDate = (label: string) => z.string().refine(isIsoDate, `${label} must be a valid date (YYYY-MM-DD)`).optional();
const flag = z.preprocess((v) => v === true || v === '1' || v === 'true', z.boolean()).default(false);

/**
 * The report scope every view shares, so the KPI strip, Summary, Outstanding Bills and Aging all
 * describe the same bills:
 *
 *  - `asOf`: bills dated on or before it, and receipts dated on or before it. Default: today in
 *    the company's time zone (the server decides).
 *  - `from` / `to`: the BILL DATE range. Never applied to receipt dates.
 *  - `bookId`: one Book.
 */
export const receivablesScopeSchema = z
  .object({
    asOf: isoDate('As of'),
    from: isoDate('From'),
    to: isoDate('To'),
    bookId: z.string().uuid('Choose a valid book').optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'From must not be after To', path: ['to'] });
export type ReceivablesScopeInput = z.infer<typeof receivablesScopeSchema>;

/** Customer summary (and the customer-wise Aging): `all` includes customers with nothing outstanding. */
export const receivableCustomersQuerySchema = z.object({ search: z.string().trim().max(100).optional(), all: flag, full: flag });
/** Outstanding Bills: which payment state, which aging bucket, and an optional exact customer. */
export const receivableBillsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(RECEIVABLE_BILL_STATUSES).default('OUTSTANDING'),
  bucket: z.enum(AGING_BUCKETS).optional(),
  customer: z.string().trim().max(40).optional(),
  full: flag,
});
export const RECEIVABLES_EXPORTS = ['customers', 'bills', 'aging'] as const;
export type ReceivablesExport = (typeof RECEIVABLES_EXPORTS)[number];

/* ------------------------------------------------------------- API shapes -- */

/** Money per aging bucket. The five always add up exactly to the Outstanding they belong to. */
export type AgingAmounts = Record<AgingBucket, number>;

/** GET /api/reports/receivables/overview — the KPI strip for the shared scope. */
export interface ReceivablesOverview {
  /** The As-of date actually used ("YYYY-MM-DD") — today in the company's zone when none was sent. */
  asOf: string;
  /** Sum of the Grand Totals of every bill in scope (paid bills included). */
  totalBilled: number;
  /** Received against those bills: ACTIVE allocations dated on or before As of. */
  totalReceived: number;
  totalOutstanding: number;
  customersWithOutstanding: number;
  pendingBills: number;
  aging: AgingAmounts;
}

export interface ReceivableCustomerRow {
  customerKey: string;
  /** As the customer's latest bill in scope names them. */
  customerName: string;
  mobileNumber: string;
  billCount: number;
  pendingBills: number;
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
  /** Bill date of the oldest bill with something outstanding, and its age in days (null when nothing is due). */
  oldestPendingDate: string | null;
  oldestPendingAge: number | null;
  aging: AgingAmounts;
}

export interface ReceivableBillRow {
  id: string;
  bookId: string;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  customerKey: string;
  customerName: string;
  mobileNumber: string;
  grandTotal: number;
  paidAmount: number;
  outstandingAmount: number;
  paymentStatus: BillPaymentStatus;
  /** Whole days from the bill date to As of. */
  ageDays: number;
  agingBucket: AgingBucket;
}

/** Totals of a list's WHOLE filtered result — never only the page on screen. */
export interface ReceivablesListTotals {
  count: number;
  billCount: number;
  pendingBills: number;
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
  aging: AgingAmounts;
}

export interface ReceivablesPage<T> {
  asOf: string;
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totals: ReceivablesListTotals;
}

/** One receipt in a customer's history, showing only what it put on THIS customer's bills in scope. */
export interface ReceivableReceiptRow {
  receiptId: string;
  receiptNumber: number;
  receiptDate: string;
  paymentMode: PaymentMode;
  accountName: string;
  /** The whole receipt. */
  receiptAmount: number;
  /** What it allocated to the bills listed — the figure Paid is made of (when ACTIVE). */
  allocatedAmount: number;
  /** "Book/Bill ₹amount" for each of those bills. */
  allocations: { billId: string; bookNumber: string; billNumber: number; amount: number }[];
  status: ReceiptStatus;
}

/** GET /api/reports/receivables/customers/:key */
export interface ReceivableCustomerDetail {
  asOf: string;
  customer: ReceivableCustomerRow;
  /** Every bill of the customer in scope, oldest first — paid ones too, so the totals are visible. */
  bills: ReceivableBillRow[];
  receipts: ReceivableReceiptRow[];
}
