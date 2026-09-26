import { and, asc, count, desc, eq, exists, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  RECEIVABLES_EXPORT_MAX_ROWS,
  normalizeMobile,
  type BillDetailReport,
  type BillDetailRow,
  type BillPaymentStatus,
  type BillReportCustomer,
  type BillReportQuery,
  type BillReportTotals,
  type BillSummaryReport,
  type BillSummaryRow,
  type InvoiceTaxMode,
} from '@erp/shared';
import { db, schema } from '../db/client';
import { containsPattern } from '../lib/filters';
import { paidSubquery, paymentColumns } from './billPayments';
import { MIN_MOBILE_SEARCH_DIGITS, billSearch } from './bills';
import { businessToday } from './company';
import { assertExportable, type Paging } from './receivables';

/**
 * Reports -> Bill Summary (docs/BILL_SUMMARY_REPORT.md) — read-only, derived, stored nowhere.
 *
 * ONE bill scope (`scopeModel`) drives both tabs, their totals and the CSV:
 *
 *  - Summary rows / totals read the bill's STORED totals (sub_total, discount_amount, gst_amount,
 *    grand_total) and its derived Paid as "Advance" (`paidSubquery` — one grouped row per bill, so
 *    a LEFT JOIN can never multiply anything).
 *  - Detailed rows / totals read the bill's stored LINES. The billing contract makes the lines add
 *    up to the bill exactly (docs/BILLING_CALCULATION.md), so Detailed totals equal Summary totals
 *    to the paisa; a line's discount is its stored `discount_allocated`, never re-allocated here.
 *    Advance belongs to the bill, not a line: it is carried on the bill's first line only.
 *
 * Money is summed by Postgres in `numeric` and only turned into a JS number for the response.
 * Every query carries the tenant predicate on `bills` (and `bill_items`); `paidSubquery` its own.
 */

const B = schema.bills;
const BK = schema.books;
const BI = schema.billItems;

export interface BillReportScope {
  tenantId: string;
  from: string | null;
  to: string | null;
  customer?: string;
  bookId?: string;
  seriesType?: InvoiceTaxMode;
  billNumber?: number;
  paymentStatus?: BillPaymentStatus;
  search?: string;
}

/** The request's scope; with no dates at all, the current month up to today (company time zone). */
export async function billReportScope(tenantId: string, q: BillReportQuery): Promise<BillReportScope> {
  let from = q.from ?? null;
  let to = q.to ?? null;
  if (!from && !to) {
    to = await businessToday(tenantId);
    from = `${to.slice(0, 8)}01`;
  }
  return { tenantId, from, to, customer: q.customer, bookId: q.bookId, seriesType: q.seriesType, billNumber: q.billNumber, paymentStatus: q.paymentStatus, search: q.search };
}

function scopeModel(s: BillReportScope) {
  const paid = paidSubquery(s.tenantId);
  const { paidAmount, paymentStatus } = paymentColumns(paid);
  const key = s.customer !== undefined ? normalizeMobile(s.customer) : undefined;
  // A search selects BILLS — by the bill's own fields or by any of its lines — so both tabs keep
  // exactly the same bills (a matching line never shows without its bill's other lines).
  const lineMatch = s.search
    ? exists(
        db
          .select({ one: sql`1` })
          .from(BI)
          .where(and(eq(BI.tenantId, s.tenantId), eq(BI.billId, B.id), or(ilike(BI.itemNameSnapshot, containsPattern(s.search)), ilike(BI.subItemNameSnapshot, containsPattern(s.search))))),
      )
    : undefined;
  const where = and(
    eq(B.tenantId, s.tenantId),
    s.from ? gte(B.billDate, s.from) : undefined,
    s.to ? lte(B.billDate, s.to) : undefined,
    key !== undefined ? (key ? eq(B.mobileSearch, key) : sql`false`) : undefined,
    s.bookId ? eq(B.bookId, s.bookId) : undefined,
    s.seriesType ? eq(B.taxMode, s.seriesType) : undefined,
    s.billNumber ? eq(B.billNumber, s.billNumber) : undefined,
    s.paymentStatus ? sql`${paymentStatus} = ${s.paymentStatus}` : undefined,
    s.search ? or(billSearch(s.search), lineMatch) : undefined,
  );
  const bookJoin = and(eq(BK.id, B.bookId), eq(BK.tenantId, B.tenantId));
  /** FROM bills + book + Paid. */
  const bills = <T extends Record<string, unknown>>(fields: T) => db.select(fields as never).from(B).innerJoin(BK, bookJoin).leftJoin(paid, eq(paid.billId, B.id));
  /** FROM bill lines + their bill + book + Paid — Paid is one row per bill, so lines are never multiplied. */
  const lines = <T extends Record<string, unknown>>(fields: T) =>
    db
      .select(fields as never)
      .from(BI)
      .innerJoin(B, and(eq(B.id, BI.billId), eq(B.tenantId, BI.tenantId)))
      .innerJoin(BK, bookJoin)
      .leftJoin(paid, eq(paid.billId, B.id));
  /** Bill-level sort keys, shared by both tabs so a sort survives a tab switch. */
  const sortable: Record<string, SQL> = {
    billDate: sql`${B.billDate}`,
    bookNumber: sql`${BK.bookNumber}`,
    billNumber: sql`(${BK.bookNumber}, ${B.billNumber})`,
    customerName: sql`lower(${B.customerName})`,
    mobileNumber: sql`${B.mobileNumber}`,
    babyName: sql`lower(${B.babyName})`,
    plannedDelivery: sql`${B.deliveryDate}`,
    subTotal: sql`${B.subTotal}`,
    discount: sql`${B.discountAmount}`,
    gst: sql`${B.gstAmount}`,
    grandTotal: sql`${B.grandTotal}`,
    advance: paidAmount,
  };
  const order = (p: Paging) => {
    const col = p.sortBy && Object.hasOwn(sortable, p.sortBy) ? sortable[p.sortBy] : undefined;
    const primary = col ? [p.sortOrder === 'asc' ? sql`${col} asc nulls last` : sql`${col} desc nulls last`] : [];
    // Chronological by default — how a period's bills are read; the bill identity breaks every tie.
    return [...primary, asc(B.billDate), asc(BK.bookNumber), asc(B.billNumber), asc(B.id)];
  };
  const billTotals = {
    bills: sql<number>`count(*)::int`,
    subTotal: sql<string>`coalesce(sum(${B.subTotal}), 0)`,
    discount: sql<string>`coalesce(sum(${B.discountAmount}), 0)`,
    gst: sql<string>`coalesce(sum(${B.gstAmount}), 0)`,
    grandTotal: sql<string>`coalesce(sum(${B.grandTotal}), 0)`,
    advance: sql<string>`coalesce(sum(${paidAmount}), 0)`,
  };
  return { paidAmount, paymentStatus, where, bills, lines, order, billTotals };
}

const num = (v: unknown) => Number(v ?? 0);
const page = <Q extends { limit: (n: number) => unknown }>(q: Q, p: Paging) =>
  (p.full ? q.limit(RECEIVABLES_EXPORT_MAX_ROWS) : (q.limit(p.limit) as unknown as { offset: (n: number) => unknown }).offset((p.page - 1) * p.limit)) as Promise<Record<string, unknown>[]>;

const shapeTotals = (r: Record<string, unknown>): BillReportTotals => ({
  bills: num(r.bills),
  subTotal: num(r.subTotal),
  discount: num(r.discount),
  gst: num(r.gst),
  grandTotal: num(r.grandTotal),
  advance: num(r.advance),
});

/** Summary: one row per bill; totals of the whole filtered set. */
export async function billSummary(s: BillReportScope, p: Paging): Promise<BillSummaryReport> {
  const m = scopeModel(s);
  const [t] = (await m.bills(m.billTotals).where(m.where)) as Record<string, unknown>[];
  const totals = shapeTotals(t);
  if (p.full) assertExportable(totals.bills);
  const rows = await page(
    m
      .bills({
        id: B.id,
        bookNumber: BK.bookNumber,
        billNumber: B.billNumber,
        billDate: B.billDate,
        plannedDelivery: B.deliveryDate,
        customerName: B.customerName,
        mobileNumber: B.mobileNumber,
        babyName: B.babyName,
        seriesType: B.taxMode,
        subTotal: B.subTotal,
        discount: B.discountAmount,
        gst: B.gstAmount,
        grandTotal: B.grandTotal,
        advance: m.paidAmount,
        paymentStatus: m.paymentStatus,
      })
      .where(m.where)
      .orderBy(...m.order(p)),
    p,
  );
  return {
    from: s.from,
    to: s.to,
    total: totals.bills,
    totals,
    rows: rows.map(
      (r): BillSummaryRow => ({
        ...(r as unknown as BillSummaryRow),
        subTotal: num(r.subTotal),
        discount: num(r.discount),
        gst: num(r.gst),
        grandTotal: num(r.grandTotal),
        advance: num(r.advance),
      }),
    ),
  };
}

/**
 * Detailed: one row per bill line, in bill order then line order, so a bill's lines sit together.
 * Line totals are summed from the LINES; Advance (a bill figure) from the same bills' Paid.
 */
export async function billDetail(s: BillReportScope, p: Paging): Promise<BillDetailReport> {
  const m = scopeModel(s);
  const where = and(m.where, eq(BI.tenantId, s.tenantId));
  const [[t], [bt]] = (await Promise.all([
    m
      .lines({
        items: sql<number>`count(*)::int`,
        bills: sql<number>`count(distinct ${B.id})::int`,
        subTotal: sql<string>`coalesce(sum(${BI.taxableAmount} + ${BI.discountAllocated}), 0)`,
        discount: sql<string>`coalesce(sum(${BI.discountAllocated}), 0)`,
        taxable: sql<string>`coalesce(sum(${BI.taxableAmount}), 0)`,
        gst: sql<string>`coalesce(sum(${BI.gstAmount}), 0)`,
        grandTotal: sql<string>`coalesce(sum(${BI.lineTotal}), 0)`,
      })
      .where(where),
    m.bills({ advance: m.billTotals.advance }).where(m.where),
  ])) as Record<string, unknown>[][];
  const totals = { ...shapeTotals({ ...t, advance: bt.advance }), items: num(t.items), taxable: num(t.taxable) };
  if (p.full) assertExportable(totals.items);
  const rows = await page(
    m
      .lines({
        billId: B.id,
        lineNumber: BI.lineNumber,
        // The bill's first line in the result — every line of a bill in scope is in it.
        firstLine: sql<boolean>`(${BI.lineNumber} = min(${BI.lineNumber}) over (partition by ${BI.billId}))`,
        bookNumber: BK.bookNumber,
        billNumber: B.billNumber,
        billDate: B.billDate,
        customerName: B.customerName,
        mobileNumber: B.mobileNumber,
        babyName: B.babyName,
        itemName: BI.itemNameSnapshot,
        productName: BI.subItemNameSnapshot,
        quantity: BI.quantity,
        rate: BI.rate,
        amount: sql<string>`(${BI.taxableAmount} + ${BI.discountAllocated})`,
        discount: BI.discountAllocated,
        taxable: BI.taxableAmount,
        gstRate: BI.gstRateSnapshot,
        gst: BI.gstAmount,
        lineTotal: BI.lineTotal,
        advance: m.paidAmount,
      })
      .where(where)
      .orderBy(...m.order(p), asc(BI.lineNumber)),
    p,
  );
  return {
    from: s.from,
    to: s.to,
    total: totals.items,
    totals,
    rows: rows.map(
      (r): BillDetailRow => ({
        ...(r as unknown as BillDetailRow),
        key: `${r.billId}:${r.lineNumber}`,
        firstLine: !!r.firstLine,
        quantity: num(r.quantity),
        rate: num(r.rate),
        amount: num(r.amount),
        discount: num(r.discount),
        taxable: num(r.taxable),
        gstRate: num(r.gstRate),
        gst: num(r.gst),
        lineTotal: num(r.lineTotal),
        advance: r.firstLine ? num(r.advance) : null,
      }),
    ),
  };
}

/**
 * The Customer filter's choices: customers (by normalized mobile) who have bills, most recently
 * billed first, named as their latest bill names them. `key` looks one customer up exactly.
 */
export async function billReportCustomers(tenantId: string, f: { search?: string; key?: string }): Promise<BillReportCustomer[]> {
  const digits = f.search ? normalizeMobile(f.search) : '';
  const key = f.key !== undefined ? normalizeMobile(f.key) : undefined;
  const latest = (col: typeof B.customerName | typeof B.mobileNumber) => sql<string>`(array_agg(${col} order by ${B.billDate} desc, ${B.createdAt} desc, ${B.id} desc))[1]`;
  const rows = await db
    .select({ customerKey: B.mobileSearch, customerName: latest(B.customerName), mobileNumber: latest(B.mobileNumber), billCount: count() })
    .from(B)
    .where(
      and(
        eq(B.tenantId, tenantId),
        key !== undefined ? (key ? eq(B.mobileSearch, key) : sql`false`) : undefined,
        f.search ? or(ilike(B.customerName, containsPattern(f.search)), digits.length >= MIN_MOBILE_SEARCH_DIGITS ? ilike(B.mobileSearch, `%${digits}%`) : undefined) : undefined,
      ),
    )
    .groupBy(B.mobileSearch)
    .orderBy(desc(sql`max(${B.billDate})`), asc(B.mobileSearch))
    .limit(20);
  return rows.map((r) => ({ ...r, billCount: Number(r.billCount) }));
}
