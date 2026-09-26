import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  BILL_MOBILE_DIGITS,
  billPaymentStatus,
  fromPaise,
  normalizeMobile,
  paymentModeForGroup,
  toPaise,
  PAYMENT_MODE_LABELS,
  type AdvanceApplicationStatus,
  type BillPaymentHistoryRow,
  type BillPayments,
  type CustomerAdvance,
  type PaymentAccountOption,
  type PaymentMode,
  type PendingBill,
  type ReceiptInput,
  type ReceiptRecord,
  type ReceiptStatus,
  type ReceivableCustomer,
} from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError, notFound, validation } from '../lib/errors';
import { allocateDocumentNumber } from './documentNumbers';
import { paidPaiseByBill, paidSubquery, paymentColumns, receiptAppliedSql, receiptAvailableSql } from './billPayments';
import { businessToday } from './company';

/**
 * Receipts — money received against saved bills (docs/RECEIPTS_PAYMENTS.md).
 *
 * The rules this file exists to keep:
 *
 *  1. **Paid is derived.** A bill's Paid is the sum of its allocations on ACTIVE receipts
 *     (`services/billPayments.ts`); nothing stores it.
 *  2. **No overpayment, even under concurrency.** Creating a receipt locks every bill it touches
 *     `FOR UPDATE`, in id order, BEFORE reading what those bills have already received. Two
 *     receipts for the same bill therefore queue: the second reads the first's allocation and is
 *     refused if it would take the bill past its Grand Total. Id order means two receipts over
 *     overlapping bills lock them in the same sequence and cannot deadlock. `updateBill` and the
 *     bill delete take the same row lock, so a bill cannot shrink or vanish mid-receipt.
 *  3. **Received = allocated + advance** (docs/ADVANCE_PAYMENTS.md). What the receipt does not put
 *     on a bill when it is saved is the customer's ADVANCE. It reduces no bill until an explicit
 *     Apply writes an `advance_applications` row; what is still available is derived, never stored.
 *  4. **One customer.** Every settled bill must carry the receipt's customer key — the normalized
 *     mobile Billing already keys customers by.
 *  5. **The account is proven for the mode**, from its Account Group, never its name.
 *  6. **Immutable history.** A receipt is never edited or deleted; a wrong one is cancelled. An
 *     applied advance is reversed, never deleted — and must be, before its receipt can be cancelled.
 *  7. **The number is taken last**, inside the transaction, so a refused receipt burns none.
 *  8. **No advance is spent twice.** Applying locks the bill, then the customer's receipts, and
 *     reads what is still available only after both locks are held.
 *
 * Receipts never touch a bill row, so they never revoke a bill's public invoice link: the
 * invoice is drawn from the bill's saved snapshot, which a payment does not change.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const B = schema.bills;
const R = schema.receipts;
const RA = schema.receiptAllocations;
const AA = schema.advanceApplications;
const A = schema.accounts;
const G = schema.accountGroups;
const createdUser = alias(schema.users, 'receipt_created_by');
const cancelledUser = alias(schema.users, 'receipt_cancelled_by');

const money = (v: unknown) => Number(v);
const userName = (u: typeof createdUser | typeof cancelledUser) => sql<string | null>`nullif(btrim(${u.firstName} || ' ' || ${u.lastName}), '')`;

/* --------------------------------------------------------------- accounts -- */

/** Active accounts that may receive money for a mode, by their group's classification. */
export async function listPaymentAccounts(tenantId: string, mode: PaymentMode): Promise<PaymentAccountOption[]> {
  const rows = await db
    .select({ id: A.id, accountName: A.accountName, groupName: G.groupName, headGroup: G.headGroup })
    .from(A)
    .innerJoin(G, and(eq(G.id, A.accountGroupId), eq(G.tenantId, A.tenantId)))
    // Narrowed in SQL to the only groups that can qualify; `paymentModeForGroup` stays the rule.
    .where(and(eq(A.tenantId, tenantId), eq(A.isActive, true), or(eq(G.headGroup, 'CASH'), sql`upper(btrim(${G.groupName})) in ('CASH', 'BANK')`)))
    .orderBy(asc(A.accountName));
  return rows.filter((r) => paymentModeForGroup(r) === mode).map(({ id, accountName, groupName }) => ({ id, accountName, groupName }));
}

/**
 * The account a receipt names, proven to be the tenant's own, active, and classified for the
 * mode. A submitted id is never trusted because a dropdown offered it.
 */
async function resolvePaymentAccount(exec: Executor, tenantId: string, accountId: string, mode: PaymentMode) {
  const [row] = await exec
    .select({ id: A.id, accountName: A.accountName, isActive: A.isActive, groupName: G.groupName, headGroup: G.headGroup })
    .from(A)
    .innerJoin(G, and(eq(G.id, A.accountGroupId), eq(G.tenantId, A.tenantId)))
    .where(and(eq(A.id, accountId), eq(A.tenantId, tenantId)))
    .limit(1);
  const fail = (message: string) => validation(message, [{ path: ['accountId'], message }]);
  if (!row) throw fail('This account does not exist');
  if (!row.isActive) throw fail(`"${row.accountName}" is inactive`);
  if (paymentModeForGroup(row) !== mode) throw fail(`"${row.accountName}" is not a ${PAYMENT_MODE_LABELS[mode].toLowerCase()} account`);
  return row;
}

/* -------------------------------------------------------------- customers -- */

/**
 * Customers with money due, keyed by the normalized mobile every bill of theirs carries.
 *
 * With `key`, exactly that customer (even with nothing outstanding) — how "Receive payment" on a
 * bill preselects its customer. Otherwise the 20 most recently billed customers with something
 * outstanding, optionally narrowed by a name or mobile search. One grouped query either way.
 */
export async function listReceivableCustomers(tenantId: string, opts: { search?: string; key?: string }): Promise<ReceivableCustomer[]> {
  const paid = paidSubquery(tenantId);
  const { outstandingAmount } = paymentColumns(paid);
  const key = opts.key !== undefined ? normalizeMobile(opts.key) : undefined;
  if (key !== undefined && !key) return [];
  const term = opts.search?.trim();
  const digits = term ? normalizeMobile(term) : '';
  const rows = await db
    .select({
      customerKey: B.mobileSearch,
      customerName: sql<string>`(array_agg(${B.customerName} order by ${B.billDate} desc, ${B.createdAt} desc))[1]`,
      mobileNumber: sql<string>`(array_agg(${B.mobileNumber} order by ${B.billDate} desc, ${B.createdAt} desc))[1]`,
      billCount: sql<number>`count(*)::int`,
      pendingBillCount: sql<number>`(count(*) filter (where ${outstandingAmount} > 0))::int`,
      totalBilled: sql<string>`sum(${B.grandTotal})`,
      totalPaid: sql<string>`sum(coalesce(${paid.paid}, 0))`,
      totalOutstanding: sql<string>`sum(${outstandingAmount})`,
    })
    .from(B)
    .leftJoin(paid, eq(paid.billId, B.id))
    .where(and(eq(B.tenantId, tenantId), key !== undefined ? eq(B.mobileSearch, key) : undefined))
    .groupBy(B.mobileSearch)
    .having(
      key !== undefined
        ? undefined
        : and(
            sql`sum(${outstandingAmount}) > 0`,
            term ? or(sql`bool_or(${B.customerName} ilike ${`%${term}%`})`, ...(digits.length >= 3 ? [sql`${B.mobileSearch} like ${`%${digits}%`}`] : [])) : undefined,
          ),
    )
    .orderBy(sql`max(${B.billDate}) desc`, asc(B.mobileSearch))
    .limit(20);
  // Exactly one customer by key who has no bill yet but has paid an advance: named by that receipt.
  if (key !== undefined && !rows.length) {
    const [r] = await db
      .select({ customerName: R.customerName, mobileNumber: R.mobileNumber })
      .from(R)
      .where(and(eq(R.tenantId, tenantId), eq(R.mobileSearch, key)))
      .orderBy(desc(R.receiptDate), desc(R.receiptNumber))
      .limit(1);
    return r ? [{ customerKey: key, ...r, billCount: 0, pendingBillCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 }] : [];
  }
  return rows.map((r) => ({ ...r, totalBilled: money(r.totalBilled), totalPaid: money(r.totalPaid), totalOutstanding: money(r.totalOutstanding) }));
}

/** A customer's bills with something still outstanding, oldest first — the order money settles them in. */
export async function listPendingBills(tenantId: string, customerKey: string): Promise<PendingBill[]> {
  const key = normalizeMobile(customerKey);
  if (!key) return [];
  const paid = paidSubquery(tenantId);
  const { paidAmount, outstandingAmount, paymentStatus } = paymentColumns(paid);
  const rows = await db
    .select({
      id: B.id,
      bookNumber: schema.books.bookNumber,
      billNumber: B.billNumber,
      billDate: B.billDate,
      customerName: B.customerName,
      grandTotal: B.grandTotal,
      paidAmount,
      outstandingAmount,
      paymentStatus,
    })
    .from(B)
    .innerJoin(schema.books, eq(schema.books.id, B.bookId))
    .leftJoin(paid, eq(paid.billId, B.id))
    .where(and(eq(B.tenantId, tenantId), eq(B.mobileSearch, key), sql`${outstandingAmount} > 0`))
    .orderBy(asc(B.billDate), asc(B.billNumber), asc(B.createdAt))
    .limit(500);
  return rows.map((r) => ({
    ...r,
    grandTotal: money(r.grandTotal),
    paidAmount: money(r.paidAmount),
    outstandingAmount: money(r.outstandingAmount),
    paymentStatus: r.paymentStatus as PendingBill['paymentStatus'],
  }));
}

/* ----------------------------------------------------------------- reads -- */

/** "Book/Bill" of every bill a receipt settles — allocated, then applied from its advance — each once. */
const billNumbersOf = sql<string>`coalesce((
  select string_agg(label, ', ' order by first_at, bill_number)
  from (
    select bk.book_number || '/' || b.bill_number as label, b.bill_number, min(s.created_at) as first_at
    from (
      select ra.bill_id, ra.created_at from receipt_allocations ra where ra.receipt_id = ${R.id} and ra.tenant_id = ${R.tenantId}
      union all
      select aa.bill_id, aa.created_at from advance_applications aa where aa.receipt_id = ${R.id} and aa.tenant_id = ${R.tenantId} and aa.status = 'ACTIVE'
    ) s
    join bills b on b.id = s.bill_id and b.tenant_id = ${R.tenantId}
    join books bk on bk.id = b.book_id
    group by bk.book_number, b.bill_number
  ) settled
), '')`;

/** The list/detail columns: the receipt, its account's name, and who created / cancelled it. */
export const receiptColumns = {
  id: R.id,
  receiptNumber: R.receiptNumber,
  receiptDate: R.receiptDate,
  customerName: R.customerName,
  mobileNumber: R.mobileNumber,
  paymentMode: R.paymentMode,
  accountId: R.accountId,
  accountName: A.accountName,
  amount: R.amount,
  appliedAmount: receiptAppliedSql,
  availableAmount: receiptAvailableSql,
  remark: R.remark,
  status: R.status,
  billNumbers: billNumbersOf,
  createdByName: userName(createdUser),
  cancelledAt: R.cancelledAt,
  cancelledByName: userName(cancelledUser),
  cancelReason: R.cancelReason,
  createdAt: R.createdAt,
  updatedAt: R.updatedAt,
};

/** FROM receipts with the joins `receiptColumns` needs. Every caller adds the tenant predicate. */
export const receiptsFrom = () =>
  db
    .select(receiptColumns)
    .from(R)
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .leftJoin(createdUser, eq(createdUser.id, R.createdBy))
    .leftJoin(cancelledUser, eq(cancelledUser.id, R.cancelledBy));

/** The same FROM for the list's count, so a filter on any of `receiptColumns` works in both. */
export async function countReceipts(where: SQL | undefined) {
  const [{ total }] = await db
    .select({ total: count() })
    .from(R)
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .leftJoin(createdUser, eq(createdUser.id, R.createdBy))
    .leftJoin(cancelledUser, eq(cancelledUser.id, R.cancelledBy))
    .where(where);
  return Number(total);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const shapeReceipt = <T extends { amount: unknown; appliedAmount: unknown; availableAmount: unknown; paymentMode: string; status: string; cancelledAt: Date | null; createdAt: Date; updatedAt: Date }>(row: T) => ({
  ...row,
  cancelledAt: iso(row.cancelledAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  amount: money(row.amount),
  appliedAmount: money(row.appliedAmount),
  availableAmount: money(row.availableAmount),
  paymentMode: row.paymentMode as PaymentMode,
  status: row.status as ReceiptStatus,
});

/** One receipt with its allocations; each allocation shows the bill's position AS OF NOW. */
export async function getReceipt(tenantId: string, id: string): Promise<ReceiptRecord> {
  const [row] = await receiptsFrom().where(and(eq(R.id, id), eq(R.tenantId, tenantId))).limit(1);
  if (!row) throw notFound('Receipt');
  const paid = paidSubquery(tenantId);
  const { paidAmount, outstandingAmount, paymentStatus } = paymentColumns(paid);
  const allocations = await db
    .select({
      id: RA.id,
      billId: RA.billId,
      bookNumber: schema.books.bookNumber,
      billNumber: B.billNumber,
      billDate: B.billDate,
      amount: RA.amount,
      grandTotal: B.grandTotal,
      paidAmount,
      outstandingAmount,
      paymentStatus,
    })
    .from(RA)
    .innerJoin(B, and(eq(B.id, RA.billId), eq(B.tenantId, RA.tenantId)))
    .innerJoin(schema.books, eq(schema.books.id, B.bookId))
    .leftJoin(paid, eq(paid.billId, B.id))
    .where(and(eq(RA.tenantId, tenantId), eq(RA.receiptId, id)))
    .orderBy(asc(RA.createdAt), asc(B.billNumber));
  const applications = await db
    .select({
      id: AA.id,
      billId: AA.billId,
      bookNumber: schema.books.bookNumber,
      billNumber: B.billNumber,
      appliedOn: AA.appliedOn,
      amount: AA.amount,
      status: AA.status,
      reversedAt: AA.reversedAt,
      reverseReason: AA.reverseReason,
    })
    .from(AA)
    .innerJoin(B, and(eq(B.id, AA.billId), eq(B.tenantId, AA.tenantId)))
    .innerJoin(schema.books, eq(schema.books.id, B.bookId))
    .where(and(eq(AA.tenantId, tenantId), eq(AA.receiptId, id)))
    .orderBy(asc(AA.createdAt));
  return {
    ...shapeReceipt(row),
    advanceAmount: fromPaise(toPaise(row.amount as string) - allocations.reduce((s, a) => s + toPaise(a.amount), 0)),
    applications: applications.map((a) => ({ ...a, amount: money(a.amount), status: a.status as AdvanceApplicationStatus, reversedAt: iso(a.reversedAt) })),
    allocations: allocations.map((a) => ({
      ...a,
      amount: money(a.amount),
      grandTotal: money(a.grandTotal),
      paidAmount: money(a.paidAmount),
      outstandingAmount: money(a.outstandingAmount),
      paymentStatus: a.paymentStatus as ReceiptRecord['allocations'][number]['paymentStatus'],
    })),
  };
}

/**
 * A bill's position, every payment that ever touched it — receipts that settled it when saved and
 * advance applied to it later, cancelled / reversed ones included, marked so — and the customer's
 * advance still available, with what Apply would propose: min(available, outstanding).
 */
export async function getBillPayments(tenantId: string, billId: string): Promise<BillPayments> {
  const [bill] = await db.select({ grandTotal: B.grandTotal, mobileSearch: B.mobileSearch }).from(B).where(and(eq(B.id, billId), eq(B.tenantId, tenantId))).limit(1);
  if (!bill) throw notFound('Bill');
  const paidPaise = (await paidPaiseByBill(db, tenantId, [billId])).get(billId) ?? 0;
  const grandTotal = money(bill.grandTotal);
  const outstandingPaise = toPaise(grandTotal) - paidPaise;
  const allocated = await db
    .select({ receiptId: R.id, receiptNumber: R.receiptNumber, date: R.receiptDate, paymentMode: R.paymentMode, accountName: A.accountName, amount: RA.amount, status: R.status })
    .from(RA)
    .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .where(and(eq(RA.tenantId, tenantId), eq(RA.billId, billId)));
  const applied = await db
    .select({ receiptId: R.id, receiptNumber: R.receiptNumber, date: AA.appliedOn, paymentMode: R.paymentMode, accountName: A.accountName, amount: AA.amount, status: R.status, applicationId: AA.id, applicationStatus: AA.status })
    .from(AA)
    .innerJoin(R, and(eq(R.id, AA.receiptId), eq(R.tenantId, AA.tenantId)))
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .where(and(eq(AA.tenantId, tenantId), eq(AA.billId, billId)));
  const history: BillPaymentHistoryRow[] = [
    ...allocated.map((h) => ({ ...h, kind: 'RECEIPT' as const, counts: h.status === 'ACTIVE', applicationId: null, applicationStatus: null })),
    ...applied.map((h) => ({ ...h, kind: 'ADVANCE' as const, counts: h.status === 'ACTIVE' && h.applicationStatus === 'ACTIVE', applicationStatus: h.applicationStatus as AdvanceApplicationStatus })),
  ]
    .map((h) => ({ ...h, amount: money(h.amount), paymentMode: h.paymentMode as PaymentMode, status: h.status as ReceiptStatus }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.receiptNumber - b.receiptNumber);
  const availablePaise = toPaise((await customerAdvance(tenantId, bill.mobileSearch)).availableAdvance);
  return {
    grandTotal,
    paidAmount: fromPaise(paidPaise),
    outstandingAmount: fromPaise(outstandingPaise),
    paymentStatus: billPaymentStatus(grandTotal, fromPaise(paidPaise)),
    history,
    availableAdvance: fromPaise(availablePaise),
    advanceToApply: fromPaise(Math.max(0, Math.min(availablePaise, outstandingPaise))),
  };
}

/* ---------------------------------------------------------------- advance -- */

/** A customer's receipts with advance still available, oldest first — the order Apply spends them in. */
export async function customerAdvance(tenantId: string, customerKey: string): Promise<CustomerAdvance> {
  const key = normalizeMobile(customerKey);
  if (!key) return { customerKey: key, availableAdvance: 0, receipts: [] };
  const rows = await db
    .select({ id: R.id, receiptNumber: R.receiptNumber, receiptDate: R.receiptDate, amount: R.amount, availableAmount: receiptAvailableSql })
    .from(R)
    .where(and(eq(R.tenantId, tenantId), eq(R.mobileSearch, key), eq(R.status, 'ACTIVE'), sql`${receiptAvailableSql} > 0`))
    .orderBy(asc(R.receiptDate), asc(R.receiptNumber));
  const receipts = rows.map((r) => ({ ...r, amount: money(r.amount), availableAmount: money(r.availableAmount) }));
  return { customerKey: key, availableAdvance: fromPaise(receipts.reduce((s, r) => s + toPaise(r.availableAmount), 0)), receipts };
}

/** `customerAdvance`'s total for many customers at once (one grouped read) — for a list page. Customers with none are absent. */
export async function availableAdvanceByCustomer(tenantId: string, customerKeys: string[]): Promise<Map<string, number>> {
  const keys = Array.from(new Set(customerKeys.filter(Boolean)));
  if (!keys.length) return new Map();
  const rows = await db
    .select({ key: R.mobileSearch, available: sql<string>`sum(${receiptAvailableSql})` })
    .from(R)
    .where(and(eq(R.tenantId, tenantId), inArray(R.mobileSearch, keys), eq(R.status, 'ACTIVE')))
    .groupBy(R.mobileSearch);
  return new Map(rows.map((r) => [r.key, money(r.available)] as const).filter(([, v]) => v > 0));
}

/**
 * Apply part of a customer's available advance to one of their bills, in ONE transaction:
 *
 *   lock the bill -> lock the customer's ACTIVE receipts (id order) -> read outstanding and
 *   available AFTER both locks -> refuse more than either -> spend the oldest advance first
 *
 * Two applies against the same advance therefore queue on the receipt locks, and the second sees
 * what the first spent — the same advance can never be applied twice. Lock order is always bill
 * then receipts (and a receipt create / bill edit takes only the bill), so no two paths can
 * deadlock. The date applied is today's business date — never before the bill or the receipt.
 */
export async function applyAdvance(tenantId: string, userId: string, billId: string, amount: number) {
  const wantPaise = toPaise(amount);
  return db.transaction(async (tx) => {
    const [bill] = await tx
      .select({ id: B.id, billNumber: B.billNumber, billDate: B.billDate, grandTotal: B.grandTotal, mobileSearch: B.mobileSearch, bookNumber: schema.books.bookNumber })
      .from(B)
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .where(and(eq(B.id, billId), eq(B.tenantId, tenantId)))
      .for('update', { of: B });
    if (!bill) throw notFound('Bill');
    const label = `Bill ${bill.bookNumber}/${bill.billNumber}`;
    const fail = (message: string) => validation(message, [{ path: ['amount'], message }]);

    await tx
      .select({ id: R.id })
      .from(R)
      .where(and(eq(R.tenantId, tenantId), eq(R.mobileSearch, bill.mobileSearch), eq(R.status, 'ACTIVE')))
      .orderBy(asc(R.id))
      .for('update');

    const outstanding = toPaise(bill.grandTotal) - ((await paidPaiseByBill(tx, tenantId, [bill.id])).get(bill.id) ?? 0);
    if (outstanding <= 0) throw fail(`${label} is already fully paid`);
    const sources = await tx
      .select({ id: R.id, receiptNumber: R.receiptNumber, receiptDate: R.receiptDate, available: receiptAvailableSql })
      .from(R)
      .where(and(eq(R.tenantId, tenantId), eq(R.mobileSearch, bill.mobileSearch), eq(R.status, 'ACTIVE'), sql`${receiptAvailableSql} > 0`))
      .orderBy(asc(R.receiptDate), asc(R.receiptNumber));
    const available = sources.reduce((s, r) => s + toPaise(r.available), 0);
    if (available <= 0) throw fail('This customer has no advance available');
    if (wantPaise > available) throw fail(`Only ₹${fromPaise(available).toFixed(2)} advance is available`);
    if (wantPaise > outstanding) throw fail(`${label} has only ₹${fromPaise(outstanding).toFixed(2)} outstanding`);

    const today = await businessToday(tenantId);
    let remaining = wantPaise;
    const rows: (typeof AA.$inferInsert)[] = [];
    const used: { receiptId: string; receiptNumber: number; amount: number }[] = [];
    for (const src of sources) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, toPaise(src.available));
      // Plain YYYY-MM-DD strings: the latest of today, the bill date and the receipt date.
      const appliedOn = [today, bill.billDate, src.receiptDate].sort().at(-1)!;
      rows.push({ tenantId, receiptId: src.id, billId: bill.id, amount: fromPaise(take).toFixed(2), appliedOn, createdBy: userId });
      used.push({ receiptId: src.id, receiptNumber: src.receiptNumber, amount: fromPaise(take) });
      remaining -= take;
    }
    await tx.insert(AA).values(rows);
    return { billLabel: `${bill.bookNumber}/${bill.billNumber}`, amount: fromPaise(wantPaise), used };
  });
}

/**
 * Reverse an applied advance: the row stays, marked REVERSED, stops counting towards the bill's
 * Paid, and the money is available again. Locks the receipt, so a reverse and a cancel of the same
 * receipt queue. A second reverse is refused.
 */
export async function reverseApplication(tenantId: string, userId: string, id: string, reason: string | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: AA.id, receiptId: AA.receiptId, billId: AA.billId, amount: AA.amount, status: AA.status })
      .from(AA)
      .where(and(eq(AA.id, id), eq(AA.tenantId, tenantId)))
      .limit(1);
    if (!row) throw notFound('Applied advance');
    const [receipt] = await tx.select({ receiptNumber: R.receiptNumber }).from(R).where(and(eq(R.id, row.receiptId), eq(R.tenantId, tenantId))).for('update');
    const [again] = await tx.select({ status: AA.status }).from(AA).where(eq(AA.id, id)).for('update');
    if (again.status !== 'ACTIVE') throw new AppError('APPLICATION_ALREADY_REVERSED', 'This applied advance is already reversed', 409);
    const now = new Date();
    await tx.update(AA).set({ status: 'REVERSED', reversedAt: now, reversedBy: userId, reverseReason: reason, updatedAt: now }).where(eq(AA.id, id));
    const [bill] = await tx.select({ bookNumber: schema.books.bookNumber, billNumber: B.billNumber }).from(B).innerJoin(schema.books, eq(schema.books.id, B.bookId)).where(eq(B.id, row.billId));
    return { receiptId: row.receiptId, receiptNumber: receipt.receiptNumber, billId: row.billId, billLabel: `${bill.bookNumber}/${bill.billNumber}`, amount: money(row.amount) };
  });
}

/* ---------------------------------------------------------------- writes -- */

/**
 * Create a receipt and its allocations in ONE transaction:
 *
 *   account -> lock bills (id order) -> customer + outstanding checks -> number -> insert
 *
 * Any refusal rolls everything back, the receipt number included.
 */
export async function createReceipt(tenantId: string, userId: string, body: ReceiptInput): Promise<string> {
  return db.transaction((tx) => createReceiptIn(tx, tenantId, userId, body));
}

/**
 * The body of `createReceipt` on a transaction the CALLER owns — so a bill created with an advance
 * (`createBill`) writes its receipt inside the bill's own transaction: the same locks, checks,
 * numbering and audit data, and a refusal rolls the bill back with it. Never a bill claiming money
 * that was not recorded, never money recorded against a bill that was not saved.
 */
export async function createReceiptIn(tx: Executor, tenantId: string, userId: string, body: ReceiptInput): Promise<string> {
  const customerKey = normalizeMobile(body.customerMobile);
  if (!customerKey) throw validation('Select the customer', [{ path: ['customerMobile'], message: 'Select the customer' }]);

  await resolvePaymentAccount(tx, tenantId, body.accountId, body.paymentMode);

  // Locked in id order — the order every receipt uses, so overlapping receipts cannot deadlock.
  const billIds = Array.from(new Set(body.allocations.map((a) => a.billId))).sort();
  const locked = billIds.length
    ? await tx
        .select({ id: B.id, billNumber: B.billNumber, billDate: B.billDate, grandTotal: B.grandTotal, mobileSearch: B.mobileSearch, bookNumber: schema.books.bookNumber })
        .from(B)
        .innerJoin(schema.books, eq(schema.books.id, B.bookId))
        .where(and(eq(B.tenantId, tenantId), inArray(B.id, billIds)))
        .orderBy(asc(B.id))
        .for('update', { of: B })
    : [];
  const billById = new Map(locked.map((b) => [b.id, b]));

  // Read AFTER the locks: a receipt that committed while this one waited is counted here.
  const paidBefore = await paidPaiseByBill(tx, tenantId, billIds);

  body.allocations.forEach((a, i) => {
    const at = (field: string, message: string) => validation(message, [{ path: ['allocations', i, field], message }]);
    const bill = billById.get(a.billId);
    if (!bill) throw at('billId', 'This bill does not exist');
    const label = `Bill ${bill.bookNumber}/${bill.billNumber}`;
    if (bill.mobileSearch !== customerKey) throw at('billId', `${label} belongs to another customer`);
    // Money cannot be received for a bill before the bill exists. Both are plain YYYY-MM-DD dates,
    // so the string comparison is the calendar comparison.
    if (body.receiptDate < bill.billDate) {
      const message = `The receipt date is before the date of ${label}`;
      throw validation(message, [{ path: ['receiptDate'], message }, { path: ['allocations', i, 'billId'], message }]);
    }
    const outstanding = toPaise(bill.grandTotal) - (paidBefore.get(bill.id) ?? 0);
    if (outstanding <= 0) throw at('amount', `${label} is already fully paid`);
    if (toPaise(a.amount) > outstanding) throw at('amount', `${label} has only ₹${fromPaise(outstanding).toFixed(2)} outstanding`);
  });

  // The customer as their latest bill names them — read by the server, never sent by the client.
  // A customer with no bill yet (an advance before billing) is named by the form, and must be a
  // real 10-digit mobile: it becomes the key their future bills will carry.
  const [billed] = await tx
    .select({ customerName: B.customerName, mobileNumber: B.mobileNumber })
    .from(B)
    .where(and(eq(B.tenantId, tenantId), eq(B.mobileSearch, customerKey)))
    .orderBy(desc(B.billDate), desc(B.createdAt))
    .limit(1);
  let customer = billed;
  if (!customer) {
    if (customerKey.length !== BILL_MOBILE_DIGITS) {
      const message = `Mobile no. must be exactly ${BILL_MOBILE_DIGITS} digits`;
      throw validation(message, [{ path: ['customerMobile'], message }]);
    }
    if (!body.customerName) throw validation('Customer name is required', [{ path: ['customerName'], message: 'Customer name is required' }]);
    customer = { customerName: body.customerName, mobileNumber: customerKey };
  }

  const receiptNumber = await allocateDocumentNumber(tx, tenantId, 'receipt');
  const amountPaise = toPaise(body.amount);
  const [receipt] = await tx
    .insert(R)
    .values({
      tenantId,
      receiptNumber,
      receiptDate: body.receiptDate,
      customerName: customer.customerName,
      mobileNumber: customer.mobileNumber,
      mobileSearch: customerKey,
      paymentMode: body.paymentMode,
      accountId: body.accountId,
      amount: fromPaise(amountPaise).toFixed(2),
      remark: body.remark,
      createdBy: userId,
    })
    .returning({ id: R.id });
  if (body.allocations.length) await tx.insert(RA).values(body.allocations.map((a) => ({ tenantId, receiptId: receipt.id, billId: a.billId, amount: a.amount.toFixed(2) })));
  return receipt.id;
}

/**
 * Cancel a receipt: it stays, with its allocations, marked CANCELLED — and those allocations stop
 * counting towards Paid. Only an ACTIVE receipt can be cancelled; a second cancel is refused.
 * Returns what was cancelled, for the audit entry.
 */
export async function cancelReceipt(tenantId: string, userId: string, id: string, reason: string | null) {
  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .select({ id: R.id, receiptNumber: R.receiptNumber, amount: R.amount, status: R.status })
      .from(R)
      .where(and(eq(R.id, id), eq(R.tenantId, tenantId)))
      .limit(1)
      .for('update');
    if (!receipt) throw notFound('Receipt');
    if (receipt.status !== 'ACTIVE') throw new AppError('RECEIPT_ALREADY_CANCELLED', `Receipt No. ${receipt.receiptNumber} is already cancelled`, 409);
    // Advance already applied to a bill is part of that bill's Paid: cancelling the receipt under it
    // would silently re-open the bill. It is reversed first, explicitly, bill by bill.
    const applied = await tx
      .select({ bookNumber: schema.books.bookNumber, billNumber: B.billNumber, amount: AA.amount })
      .from(AA)
      .innerJoin(B, and(eq(B.id, AA.billId), eq(B.tenantId, AA.tenantId)))
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .where(and(eq(AA.tenantId, tenantId), eq(AA.receiptId, id), eq(AA.status, 'ACTIVE')));
    if (applied.length) {
      const where = applied.map((a) => `Bill ${a.bookNumber}/${a.billNumber} (₹${money(a.amount).toFixed(2)})`).join(', ');
      throw new AppError('RECEIPT_ADVANCE_APPLIED', `Advance from Receipt No. ${receipt.receiptNumber} is applied to ${where}. Reverse it on that bill first, then cancel the receipt.`, 409);
    }
    const now = new Date();
    await tx
      .update(R)
      .set({ status: 'CANCELLED', cancelledAt: now, cancelledBy: userId, cancelReason: reason, updatedAt: now })
      .where(and(eq(R.id, id), eq(R.tenantId, tenantId)));
    return { receiptNumber: receipt.receiptNumber, amount: money(receipt.amount) };
  });
}

/* ------------------------------------------------------------------ list -- */

/** Below this, a digit string is a document number, not a phone fragment. */
const MIN_MOBILE_SEARCH_DIGITS = 4;
const INT4_MAX = 2147483647;

/**
 * The list search: receipt number, customer, mobile, and any bill the receipt settles ("25" or
 * "2026-27/25"). The bill match is one EXISTS over the allocations — no per-row query.
 */
export function receiptSearch(term: string | undefined) {
  if (!term) return undefined;
  const digits = normalizeMobile(term);
  const isNumber = /^\d+$/.test(term);
  const asNumber = isNumber && Number(term) <= INT4_MAX ? Number(term) : null;
  const billMatch = sql`exists (
    select 1 from (
      select ra.bill_id from receipt_allocations ra where ra.receipt_id = ${R.id} and ra.tenant_id = ${R.tenantId}
      union all
      select aa.bill_id from advance_applications aa where aa.receipt_id = ${R.id} and aa.tenant_id = ${R.tenantId} and aa.status = 'ACTIVE'
    ) s
    join bills b on b.id = s.bill_id and b.tenant_id = ${R.tenantId}
    join books bk on bk.id = b.book_id
    where ${asNumber !== null ? sql`b.bill_number = ${asNumber}` : sql`(bk.book_number || '/' || b.bill_number) ilike ${`%${term}%`}`}
  )`;
  return or(
    ...(isNumber ? [] : [ilike(R.customerName, `%${term}%`), ilike(R.mobileNumber, `%${term}%`), ilike(A.accountName, `%${term}%`)]),
    ...(digits.length >= MIN_MOBILE_SEARCH_DIGITS ? [ilike(R.mobileSearch, `%${digits}%`)] : []),
    ...(asNumber !== null ? [eq(R.receiptNumber, asNumber)] : []),
    billMatch,
  );
}

