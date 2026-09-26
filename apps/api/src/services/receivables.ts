import { and, asc, count, desc, eq, gt, gte, lte, sql, type SQL } from 'drizzle-orm';
import {
  AGING_BUCKETS,
  AGING_BUCKET_MAX_DAYS,
  RECEIVABLES_EXPORT_MAX_ROWS,
  normalizeMobile,
  type AgingAmounts,
  type AgingBucket,
  type BillPaymentStatus,
  type PaymentMode,
  type ReceiptStatus,
  type ReceivableBillRow,
  type ReceivableBillStatus,
  type ReceivableCustomerDetail,
  type ReceivableCustomerRow,
  type ReceivableReceiptRow,
  type ReceivablesListTotals,
  type ReceivablesOverview,
} from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError, notFound } from '../lib/errors';
import { paidSubquery, paymentColumns } from './billPayments';
import { billSearch } from './bills';

/**
 * Receivables / Outstanding reports (docs/RECEIVABLES_REPORTS.md) — read-only, derived, stored nowhere.
 *
 * Everything here is built on ONE bill-level model (`billModel`): the Phase 6 `paidSubquery` /
 * `paymentColumns` (Paid = ACTIVE allocations, Outstanding = Grand Total - Paid), narrowed to the
 * As-of date, plus the bill's age and aging bucket. The KPI strip, the customer Summary, the
 * Outstanding Bills list, Aging and the customer drill-down all aggregate that same model over
 * the same scope, so their totals cannot drift apart:
 *
 *   Summary Outstanding = Outstanding Bills total = sum of the five aging buckets.
 *
 * Money is summed by Postgres in `numeric` — exact — and only turned into a JS number for the
 * response. Paid is always a sum of ALLOCATIONS, never of receipt amounts, so a receipt that
 * settled several bills is counted once per bill, for exactly what it put on that bill.
 *
 * Every query carries the tenant predicate on `bills`; `paidSubquery` carries its own inside.
 */

const B = schema.bills;
const BK = schema.books;
const R = schema.receipts;
const RA = schema.receiptAllocations;
const AA = schema.advanceApplications;
const A = schema.accounts;


/** The report scope every view shares (see `receivablesScopeSchema`), with As of resolved. */
export interface ReceivablesScope {
  tenantId: string;
  asOf: string;
  from?: string;
  to?: string;
  bookId?: string;
}

/* ------------------------------------------------------------------- dates -- */

export { businessToday } from './company';

/* -------------------------------------------------------------- the model -- */

/**
 * One bill's receivable position as of the scope's date, as SQL over `bills` + `books` + the
 * as-of `paidSubquery`. Nothing in here is a second formula: Paid / Outstanding / Status are
 * Phase 6's `paymentColumns`, and the bucket boundaries are `AGING_BUCKET_MAX_DAYS`.
 */
function billModel(scope: ReceivablesScope) {
  const paid = paidSubquery(scope.tenantId, scope.asOf);
  const { paidAmount, outstandingAmount, paymentStatus } = paymentColumns(paid);
  // A plain date minus a plain date is whole days in Postgres; bills dated after As of are out of
  // scope, so this is never negative — `greatest` only makes that explicit.
  const ageDays = sql<number>`greatest(0, ${scope.asOf}::date - ${B.billDate})`;
  const agingBucket = sql<AgingBucket>`(case
    when ${ageDays} <= ${AGING_BUCKET_MAX_DAYS.CURRENT} then 'CURRENT'
    when ${ageDays} <= ${AGING_BUCKET_MAX_DAYS.D1_30} then 'D1_30'
    when ${ageDays} <= ${AGING_BUCKET_MAX_DAYS.D31_60} then 'D31_60'
    when ${ageDays} <= ${AGING_BUCKET_MAX_DAYS.D61_90} then 'D61_90'
    else 'D90_PLUS' end)`;
  const where = and(
    eq(B.tenantId, scope.tenantId),
    lte(B.billDate, scope.asOf),
    scope.from ? gte(B.billDate, scope.from) : undefined,
    scope.to ? lte(B.billDate, scope.to) : undefined,
    scope.bookId ? eq(B.bookId, scope.bookId) : undefined,
  );
  /** FROM bills, its book and its as-of Paid. Callers add `where` (and their own narrowing). */
  const from = <T extends Record<string, unknown>>(fields: T) =>
    db
      .select(fields as never)
      .from(B)
      .innerJoin(BK, and(eq(BK.id, B.bookId), eq(BK.tenantId, B.tenantId)))
      .leftJoin(paid, eq(paid.billId, B.id));
  /** The outstanding money of this bill in one bucket (0 elsewhere) — what every aging sum is made of. */
  const inBucket = (b: AgingBucket) => sql`${outstandingAmount} > 0 and ${agingBucket} = ${b}`;
  const agingSums = Object.fromEntries(AGING_BUCKETS.map((b) => [b, sql<string>`coalesce(sum(${outstandingAmount}) filter (where ${inBucket(b)}), 0)`])) as Record<AgingBucket, SQL<string>>;
  return { paidAmount, outstandingAmount, paymentStatus, ageDays, agingBucket, where, from, agingSums };
}

const num = (v: unknown) => Number(v ?? 0);
const agingOf = (r: Record<string, unknown>, prefix = ''): AgingAmounts =>
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, num(r[`${prefix}${b}`])])) as AgingAmounts;

/** Refuse — never silently cut — an export or print past the row ceiling. */
export function assertExportable(total: number) {
  if (total > RECEIVABLES_EXPORT_MAX_ROWS) {
    throw new AppError('REPORT_TOO_LARGE', `This report has ${total} rows; export and print carry at most ${RECEIVABLES_EXPORT_MAX_ROWS}. Narrow the filters and try again.`, 422);
  }
}

export interface Paging {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
  /** Every row of the filtered result (print / CSV) instead of one page. */
  full?: boolean;
}

/* ------------------------------------------------------------- overview -- */

/** The KPI strip: every bill in scope, paid ones included, in ONE aggregate. */
export async function receivablesOverview(scope: ReceivablesScope): Promise<ReceivablesOverview> {
  const m = billModel(scope);
  const [r] = (await m
    .from({
      totalBilled: sql<string>`coalesce(sum(${B.grandTotal}), 0)`,
      totalReceived: sql<string>`coalesce(sum(${m.paidAmount}), 0)`,
      totalOutstanding: sql<string>`coalesce(sum(${m.outstandingAmount}), 0)`,
      customersWithOutstanding: sql<number>`(count(distinct ${B.mobileSearch}) filter (where ${m.outstandingAmount} > 0))::int`,
      pendingBills: sql<number>`(count(*) filter (where ${m.outstandingAmount} > 0))::int`,
      ...m.agingSums,
    })
    .where(m.where)) as Record<string, unknown>[];
  return {
    asOf: scope.asOf,
    totalBilled: num(r.totalBilled),
    totalReceived: num(r.totalReceived),
    totalOutstanding: num(r.totalOutstanding),
    customersWithOutstanding: num(r.customersWithOutstanding),
    pendingBills: num(r.pendingBills),
    aging: agingOf(r),
  };
}

/* --------------------------------------------------------- outstanding bills -- */

export interface BillFilters {
  status: ReceivableBillStatus;
  bucket?: AgingBucket;
  search?: string;
  /** An exact customer key (normalized mobile) — the customer drill-down. */
  customer?: string;
}

function billFilterWhere(m: ReturnType<typeof billModel>, f: BillFilters): SQL | undefined {
  const status =
    f.status === 'OUTSTANDING' ? gt(m.outstandingAmount, sql`0`) : f.status === 'ALL' ? undefined : eq(m.paymentStatus, f.status satisfies BillPaymentStatus);
  const key = f.customer !== undefined ? normalizeMobile(f.customer) : undefined;
  return and(
    m.where,
    status,
    f.bucket ? eq(m.agingBucket, f.bucket) : undefined,
    billSearch(f.search),
    key !== undefined ? (key ? eq(B.mobileSearch, key) : sql`false`) : undefined,
  );
}

const billRowFields = (m: ReturnType<typeof billModel>) => ({
  id: B.id,
  bookId: B.bookId,
  bookNumber: BK.bookNumber,
  billNumber: B.billNumber,
  billDate: B.billDate,
  customerKey: B.mobileSearch,
  customerName: B.customerName,
  mobileNumber: B.mobileNumber,
  grandTotal: B.grandTotal,
  paidAmount: m.paidAmount,
  outstandingAmount: m.outstandingAmount,
  paymentStatus: m.paymentStatus,
  ageDays: m.ageDays,
  agingBucket: m.agingBucket,
});

const shapeBillRow = (r: Record<string, unknown>): ReceivableBillRow => ({
  ...(r as unknown as ReceivableBillRow),
  grandTotal: num(r.grandTotal),
  paidAmount: num(r.paidAmount),
  outstandingAmount: num(r.outstandingAmount),
  ageDays: num(r.ageDays),
});

/** Totals of a bill set — the same aggregate for the list footer, whatever page is on screen. */
async function billTotals(m: ReturnType<typeof billModel>, where: SQL | undefined): Promise<ReceivablesListTotals> {
  const [r] = (await m
    .from({
      count: sql<number>`count(*)::int`,
      pendingBills: sql<number>`(count(*) filter (where ${m.outstandingAmount} > 0))::int`,
      totalBilled: sql<string>`coalesce(sum(${B.grandTotal}), 0)`,
      totalPaid: sql<string>`coalesce(sum(${m.paidAmount}), 0)`,
      totalOutstanding: sql<string>`coalesce(sum(${m.outstandingAmount}), 0)`,
      ...m.agingSums,
    })
    .where(where)) as Record<string, unknown>[];
  return {
    count: num(r.count),
    billCount: num(r.count),
    pendingBills: num(r.pendingBills),
    totalBilled: num(r.totalBilled),
    totalPaid: num(r.totalPaid),
    totalOutstanding: num(r.totalOutstanding),
    aging: agingOf(r),
  };
}

export async function receivableBills(scope: ReceivablesScope, filters: BillFilters, paging: Paging) {
  const m = billModel(scope);
  const where = billFilterWhere(m, filters);
  const totals = await billTotals(m, where);
  if (paging.full) assertExportable(totals.count);
  const sortable: Record<string, SQL | typeof B.billDate> = {
    billDate: B.billDate,
    bookNumber: sql`${BK.bookNumber}`,
    // The screen shows "Book/Bill" in one column: a row value sorts by book, then number.
    billNumber: sql`(${BK.bookNumber}, ${B.billNumber})`,
    customerName: sql`lower(${B.customerName})`,
    mobileNumber: sql`${B.mobileNumber}`,
    grandTotal: sql`${B.grandTotal}`,
    paidAmount: m.paidAmount,
    outstandingAmount: m.outstandingAmount,
    paymentStatus: m.paymentStatus,
    ageDays: m.ageDays,
    agingBucket: m.ageDays,
  };
  const dir = paging.sortOrder === 'asc' ? asc : desc;
  // Oldest first by default — the order money is chased in; the bill identity breaks every tie.
  const primary = paging.sortBy && sortable[paging.sortBy] ? [dir(sortable[paging.sortBy])] : [];
  const q = m
    .from(billRowFields(m))
    .where(where)
    .orderBy(...primary, asc(B.billDate), asc(BK.bookNumber), asc(B.billNumber), asc(B.id));
  const rows = (await (paging.full ? q.limit(RECEIVABLES_EXPORT_MAX_ROWS) : q.limit(paging.limit).offset((paging.page - 1) * paging.limit))) as Record<string, unknown>[];
  return { rows: rows.map(shapeBillRow), total: totals.count, totals };
}

/* ------------------------------------------------------------ customers -- */

export interface CustomerFilters {
  search?: string;
  /** Include customers with nothing outstanding in scope. */
  all?: boolean;
  /** Exactly this customer key (the drill-down header). */
  customer?: string;
}

/**
 * Customers aggregated FIRST — every in-scope bill of theirs grouped by the normalized mobile —
 * and only then filtered, sorted and paginated. A page of bills is never grouped in the browser.
 *
 * A search selects CUSTOMERS (any of their bills matching: a name spelling, the mobile, a bill or
 * book number) and still totals all of their in-scope bills, so a search can never show a
 * customer's partial balance.
 */
function customerGroups(scope: ReceivablesScope, f: CustomerFilters) {
  const m = billModel(scope);
  const search = billSearch(f.search);
  const key = f.customer !== undefined ? normalizeMobile(f.customer) : undefined;
  const latest = (col: SQL | typeof B.customerName) => sql<string>`(array_agg(${col} order by ${B.billDate} desc, ${B.createdAt} desc, ${B.id} desc))[1]`;
  const agingCols = Object.fromEntries(AGING_BUCKETS.map((b) => [`aging_${b}`, m.agingSums[b].as(`aging_${b.toLowerCase()}`)]));
  return m
    .from({
      customerKey: sql<string>`${B.mobileSearch}`.as('customer_key'),
      customerName: latest(sql`${B.customerName}`).as('customer_name'),
      mobileNumber: latest(sql`${B.mobileNumber}`).as('mobile_number'),
      billCount: sql<number>`count(*)::int`.as('bill_count'),
      pendingBills: sql<number>`(count(*) filter (where ${m.outstandingAmount} > 0))::int`.as('pending_bills'),
      totalBilled: sql<string>`sum(${B.grandTotal})`.as('total_billed'),
      totalPaid: sql<string>`sum(${m.paidAmount})`.as('total_paid'),
      totalOutstanding: sql<string>`sum(${m.outstandingAmount})`.as('total_outstanding'),
      oldestPendingDate: sql<string | null>`(min(${B.billDate}) filter (where ${m.outstandingAmount} > 0))::text`.as('oldest_pending_date'),
      ...agingCols,
    })
    .where(and(m.where, key !== undefined ? (key ? eq(B.mobileSearch, key) : sql`false`) : undefined))
    .groupBy(B.mobileSearch)
    .having(and(f.all ? undefined : sql`sum(${m.outstandingAmount}) > 0`, search ? sql`bool_or(${search})` : undefined))
    .as('receivable_customers');
}

/** The grouped subquery's columns, by the names `customerGroups` selects them under. */
const CUSTOMER_GROUP_FIELDS = [
  'customerKey',
  'customerName',
  'mobileNumber',
  'billCount',
  'pendingBills',
  'totalBilled',
  'totalPaid',
  'totalOutstanding',
  'oldestPendingDate',
  ...AGING_BUCKETS.map((b) => `aging_${b}`),
];

type CustomerGroups = ReturnType<typeof customerGroups>;
const G = (g: CustomerGroups) => g as unknown as Record<string, SQL.Aliased>;

function shapeCustomerRow(r: Record<string, unknown>): ReceivableCustomerRow {
  const oldest = (r.oldestPendingDate as string | null) ?? null;
  return {
    customerKey: String(r.customerKey),
    customerName: String(r.customerName),
    mobileNumber: String(r.mobileNumber),
    billCount: num(r.billCount),
    pendingBills: num(r.pendingBills),
    totalBilled: num(r.totalBilled),
    totalPaid: num(r.totalPaid),
    totalOutstanding: num(r.totalOutstanding),
    oldestPendingDate: oldest,
    oldestPendingAge: oldest ? Math.max(0, num(r.oldestPendingAge)) : null,
    aging: agingOf(r, 'aging_'),
  };
}

export async function receivableCustomers(scope: ReceivablesScope, filters: CustomerFilters, paging: Paging) {
  const g = customerGroups(scope, filters);
  const c = G(g);
  const agingTotals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, sql<string>`coalesce(sum(${c[`aging_${b}`]}), 0)`]));
  const [t] = (await db
    .select({
      count: count(),
      billCount: sql<number>`coalesce(sum(${c.billCount}), 0)::int`,
      pendingBills: sql<number>`coalesce(sum(${c.pendingBills}), 0)::int`,
      totalBilled: sql<string>`coalesce(sum(${c.totalBilled}), 0)`,
      totalPaid: sql<string>`coalesce(sum(${c.totalPaid}), 0)`,
      totalOutstanding: sql<string>`coalesce(sum(${c.totalOutstanding}), 0)`,
      ...agingTotals,
    })
    .from(g)) as Record<string, unknown>[];
  const totals: ReceivablesListTotals = {
    count: num(t.count),
    billCount: num(t.billCount),
    pendingBills: num(t.pendingBills),
    totalBilled: num(t.totalBilled),
    totalPaid: num(t.totalPaid),
    totalOutstanding: num(t.totalOutstanding),
    aging: agingOf(t),
  };
  if (paging.full) assertExportable(totals.count);

  const oldestPendingAge = sql<number | null>`(${scope.asOf}::date - ${c.oldestPendingDate}::date)`;
  const sortable: Record<string, SQL> = {
    customerName: sql`lower(${c.customerName})`,
    mobileNumber: sql`${c.mobileNumber}`,
    totalBilled: sql`${c.totalBilled}`,
    totalPaid: sql`${c.totalPaid}`,
    totalOutstanding: sql`${c.totalOutstanding}`,
    pendingBills: sql`${c.pendingBills}`,
    oldestPendingAge: sql`${oldestPendingAge}`,
    ...Object.fromEntries(AGING_BUCKETS.map((b) => [`aging.${b}`, sql`${c[`aging_${b}`]}`])),
  };
  const nulls = paging.sortOrder === 'asc' ? sql`asc nulls last` : sql`desc nulls last`;
  // Biggest balance first by default; the customer key breaks every tie, so pages never overlap.
  const primary = paging.sortBy && sortable[paging.sortBy] ? sql`${sortable[paging.sortBy]} ${nulls}` : sql`${c.totalOutstanding} desc`;
  const fields = { ...Object.fromEntries(CUSTOMER_GROUP_FIELDS.map((k) => [k, c[k]])), oldestPendingAge };
  const q = db
    .select(fields as never)
    .from(g)
    .orderBy(primary, asc(c.customerKey));
  const rows = (await (paging.full ? q.limit(RECEIVABLES_EXPORT_MAX_ROWS) : q.limit(paging.limit).offset((paging.page - 1) * paging.limit))) as Record<string, unknown>[];
  return { rows: rows.map(shapeCustomerRow), total: totals.count, totals };
}

/* ------------------------------------------------------ customer drill-down -- */

/**
 * One customer: the header (their Summary row), every bill of theirs in scope, and the receipts
 * that settled those bills. Each receipt shows its full amount AND what it allocated to these
 * bills; only the allocations count towards Paid, and only while the receipt is ACTIVE.
 */
export async function receivableCustomerDetail(scope: ReceivablesScope, customerKey: string): Promise<ReceivableCustomerDetail> {
  const key = normalizeMobile(customerKey);
  if (!key) throw notFound('Customer');
  const { rows } = await receivableCustomers(scope, { all: true, customer: key }, { page: 1, limit: 1, sortOrder: 'desc' });
  if (!rows.length) throw notFound('Customer');
  const { rows: bills } = await receivableBills(scope, { status: 'ALL', customer: key }, { page: 1, limit: 1, sortOrder: 'asc', full: true });

  const m = billModel(scope);
  const allocated = await db
    .select({
      receiptId: R.id,
      receiptNumber: R.receiptNumber,
      receiptDate: R.receiptDate,
      paymentMode: R.paymentMode,
      accountName: A.accountName,
      receiptAmount: R.amount,
      status: R.status,
      billId: B.id,
      bookNumber: BK.bookNumber,
      billNumber: B.billNumber,
      amount: RA.amount,
    })
    .from(RA)
    .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .innerJoin(B, and(eq(B.id, RA.billId), eq(B.tenantId, RA.tenantId)))
    .innerJoin(BK, and(eq(BK.id, B.bookId), eq(BK.tenantId, B.tenantId)))
    .where(and(eq(RA.tenantId, scope.tenantId), m.where, eq(B.mobileSearch, key), lte(R.receiptDate, scope.asOf)))
    .orderBy(asc(R.receiptDate), asc(R.receiptNumber), asc(B.billDate), asc(B.billNumber));
  // Advance applied to these bills on or before As of. Reversed applications count nowhere, so they
  // are not listed; applications of a since-cancelled receipt are listed under it, as cancelled.
  const applied = await db
    .select({
      receiptId: R.id,
      receiptNumber: R.receiptNumber,
      receiptDate: R.receiptDate,
      paymentMode: R.paymentMode,
      accountName: A.accountName,
      receiptAmount: R.amount,
      status: R.status,
      billId: B.id,
      bookNumber: BK.bookNumber,
      billNumber: B.billNumber,
      amount: AA.amount,
    })
    .from(AA)
    .innerJoin(R, and(eq(R.id, AA.receiptId), eq(R.tenantId, AA.tenantId)))
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .innerJoin(B, and(eq(B.id, AA.billId), eq(B.tenantId, AA.tenantId)))
    .innerJoin(BK, and(eq(BK.id, B.bookId), eq(BK.tenantId, B.tenantId)))
    .where(and(eq(AA.tenantId, scope.tenantId), m.where, eq(B.mobileSearch, key), eq(AA.status, 'ACTIVE'), lte(AA.appliedOn, scope.asOf)))
    .orderBy(asc(AA.appliedOn), asc(R.receiptNumber), asc(B.billDate), asc(B.billNumber));

  // One row per receipt; its allocations (and applied advance) to this customer's in-scope bills nested under it.
  const byReceipt = new Map<string, ReceivableReceiptRow & { paise: number }>();
  for (const a of [...allocated, ...applied]) {
    let r = byReceipt.get(a.receiptId);
    if (!r) {
      r = {
        receiptId: a.receiptId,
        receiptNumber: a.receiptNumber,
        receiptDate: a.receiptDate,
        paymentMode: a.paymentMode as PaymentMode,
        accountName: a.accountName,
        receiptAmount: num(a.receiptAmount),
        allocatedAmount: 0,
        allocations: [],
        status: a.status as ReceiptStatus,
        paise: 0,
      };
      byReceipt.set(a.receiptId, r);
    }
    // Summed in whole paise (the column is 2-decimal numeric), so the nested total is exact.
    r.paise += Math.round(num(a.amount) * 100);
    r.allocations.push({ billId: a.billId, bookNumber: a.bookNumber, billNumber: a.billNumber, amount: num(a.amount) });
  }
  const receipts = [...byReceipt.values()]
    .sort((a, b) => a.receiptDate.localeCompare(b.receiptDate) || a.receiptNumber - b.receiptNumber)
    .map(({ paise, ...r }) => ({ ...r, allocatedAmount: paise / 100 }));
  return { asOf: scope.asOf, customer: rows[0], bills, receipts };
}
