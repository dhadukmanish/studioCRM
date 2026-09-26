import { z } from 'zod';
import { isIsoDate } from './dates.js';
import { INVOICE_TAX_MODES, type InvoiceTaxMode } from './enums.js';
import { BILL_PAYMENT_STATUSES, type BillPaymentStatus } from './receipts.js';

/**
 * Reports -> Bill Summary (docs/BILL_SUMMARY_REPORT.md) — the legacy "Bill Summary Report": the
 * bills of a period, with Sub Total, Discount, Advance and Grand Total, as ONE screen with two tabs
 * over ONE scope.
 *
 *  - Summary: one row per bill.
 *  - Detailed: one row per bill line (item), grouped by bill.
 *
 * Every figure is the SAVED bill's: Sub Total, Discount, GST and Grand Total are the bill's stored
 * totals (the lines' snapshot sums, exactly — docs/BILLING_CALCULATION.md), never recomputed from
 * Item Master. **Advance** is what the bill has RECEIVED — the one derived Paid
 * (`services/billPayments.ts`): allocations of ACTIVE receipts plus ACTIVE advance applications.
 * A customer's advance not applied to the bill is not in it; nothing is stored.
 */

export const BILL_REPORT_TABS = ['summary', 'detailed'] as const;
export type BillReportTab = (typeof BILL_REPORT_TABS)[number];
export const BILL_REPORT_TAB_LABELS: Record<BillReportTab, string> = { summary: 'Summary', detailed: 'Detailed' };

const isoDate = (label: string) => z.string().refine(isIsoDate, `${label} must be a valid date (YYYY-MM-DD)`).optional();
const flag = z.preprocess((v) => v === true || v === '1' || v === 'true', z.boolean()).default(false);
/** An empty query-string value means "not set". */
const blank = (v: unknown) => (v === '' ? undefined : v);

/**
 * The scope both tabs share. `from` / `to` are the BILL DATE; without either the server uses the
 * current month (in the company's time zone) and says which range it used.
 */
export const billReportQuerySchema = z
  .object({
    from: isoDate('From'),
    to: isoDate('To'),
    /** A customer key — the normalized mobile (the temporary customer identity). */
    customer: z.preprocess(blank, z.string().trim().max(40).optional()),
    bookId: z.preprocess(blank, z.string().uuid('Choose a valid book').optional()),
    /** The bill's tax mode, which its Book's series type decided. */
    seriesType: z.preprocess(blank, z.enum(INVOICE_TAX_MODES, { errorMap: () => ({ message: 'Choose With GST or Without GST' }) }).optional()),
    billNumber: z.preprocess(blank, z.coerce.number({ invalid_type_error: 'Bill No. must be a number' }).int('Bill No. must be a whole number').min(1, 'Bill No. must be 1 or more').max(2_147_483_647).optional()),
    paymentStatus: z.preprocess(blank, z.enum(BILL_PAYMENT_STATUSES, { errorMap: () => ({ message: 'Choose a payment status' }) }).optional()),
    /** Customer, mobile, baby name, book / bill no., item or product. Selects BILLS, so both tabs keep one scope. */
    search: z.preprocess(blank, z.string().trim().max(100).optional()),
    /** Every row of the filtered result (print / preview / CSV) instead of one page. */
    full: flag,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'From must not be after To', path: ['to'] });
export type BillReportQuery = z.infer<typeof billReportQuerySchema>;

export const billReportExportQuerySchema = z.object({ tab: z.enum(BILL_REPORT_TABS) });

/* ------------------------------------------------------------- API shapes -- */

export interface BillSummaryRow {
  id: string;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  /** The bill's Delivery Date — the PLANNED one. */
  plannedDelivery: string | null;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  seriesType: InvoiceTaxMode;
  subTotal: number;
  discount: number;
  gst: number;
  grandTotal: number;
  /** Received against this bill (derived Paid). */
  advance: number;
  paymentStatus: BillPaymentStatus;
}

/** Totals of the WHOLE filtered result, whatever page is on screen. */
export interface BillReportTotals {
  bills: number;
  subTotal: number;
  discount: number;
  gst: number;
  grandTotal: number;
  advance: number;
}

export interface BillDetailRow {
  /** bill id + line number: unique per row. */
  key: string;
  billId: string;
  lineNumber: number;
  /** The bill's first line — the row that carries the bill-level Advance. */
  firstLine: boolean;
  bookNumber: string;
  billNumber: number;
  billDate: string;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  itemName: string;
  productName: string;
  quantity: number;
  rate: number;
  /** Qty x Rate, before discount (the line's share of Sub Total). */
  amount: number;
  /** The line's stored share of the bill discount (`discount_allocated`) — never re-allocated here. */
  discount: number;
  /** Amount - Discount: what GST was charged on. */
  taxable: number;
  gstRate: number;
  gst: number;
  lineTotal: number;
  /** The bill's Advance on its first line; null on its other lines, so the column adds up. */
  advance: number | null;
}

export interface BillDetailTotals extends BillReportTotals {
  items: number;
  taxable: number;
}

export interface BillSummaryReport {
  /** The bill-date range actually used (null = open on that side). */
  from: string | null;
  to: string | null;
  rows: BillSummaryRow[];
  total: number;
  totals: BillReportTotals;
}

export interface BillDetailReport {
  /** The bill-date range actually used (null = open on that side). */
  from: string | null;
  to: string | null;
  rows: BillDetailRow[];
  /** Line count — what the Detailed tab pages through. */
  total: number;
  totals: BillDetailTotals;
}

/** GET /api/reports/bills/customers — the Customer filter's choices. */
export interface BillReportCustomer {
  customerKey: string;
  /** As their latest bill names them. */
  customerName: string;
  mobileNumber: string;
  billCount: number;
}
