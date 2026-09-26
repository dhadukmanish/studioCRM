import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  billPaymentStatus,
  fromPaise,
  normalizeMobile,
  paymentModeForGroup,
  toPaise,
  PAYMENT_MODE_LABELS,
  type BillPaymentHistoryRow,
  type BillPayments,
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
import { paidPaiseByBill, paidSubquery, paymentColumns } from './billPayments';

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
 *  3. **The receipt is exactly its allocations.** The schema proves amount = sum of allocations;
 *     nothing is ever left unallocated.
 *  4. **One customer.** Every settled bill must carry the receipt's customer key — the normalized
 *     mobile Billing already keys customers by.
 *  5. **The account is proven for the mode**, from its Account Group, never its name.
 *  6. **Immutable history.** A receipt is never edited or deleted; a wrong one is cancelled.
 *  7. **The number is taken last**, inside the transaction, so a refused receipt burns none.
 *
 * Receipts never touch a bill row, so they never revoke a bill's public invoice link: the
 * invoice is drawn from the bill's saved snapshot, which a payment does not change.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const B = schema.bills;
const R = schema.receipts;
const RA = schema.receiptAllocations;
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

/** "Book/Bill" of every bill a receipt settles, in the order they were allocated. */
const billNumbersOf = sql<string>`coalesce((
  select string_agg(bk.book_number || '/' || b.bill_number, ', ' order by ra.created_at, b.bill_number)
  from receipt_allocations ra
  join bills b on b.id = ra.bill_id and b.tenant_id = ra.tenant_id
  join books bk on bk.id = b.book_id
  where ra.receipt_id = ${R.id} and ra.tenant_id = ${R.tenantId}
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

export const shapeReceipt = <T extends { amount: unknown; paymentMode: string; status: string; cancelledAt: Date | null; createdAt: Date; updatedAt: Date }>(row: T) => ({
  ...row,
  cancelledAt: iso(row.cancelledAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  amount: money(row.amount),
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
  return {
    ...shapeReceipt(row),
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

/** A bill's position and every receipt that ever settled it — cancelled ones included, as cancelled. */
export async function getBillPayments(tenantId: string, billId: string): Promise<BillPayments> {
  const [bill] = await db.select({ grandTotal: B.grandTotal }).from(B).where(and(eq(B.id, billId), eq(B.tenantId, tenantId))).limit(1);
  if (!bill) throw notFound('Bill');
  const paidPaise = (await paidPaiseByBill(db, tenantId, [billId])).get(billId) ?? 0;
  const grandTotal = money(bill.grandTotal);
  const history = await db
    .select({ receiptId: R.id, receiptNumber: R.receiptNumber, receiptDate: R.receiptDate, paymentMode: R.paymentMode, accountName: A.accountName, amount: RA.amount, status: R.status })
    .from(RA)
    .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
    .innerJoin(A, and(eq(A.id, R.accountId), eq(A.tenantId, R.tenantId)))
    .where(and(eq(RA.tenantId, tenantId), eq(RA.billId, billId)))
    .orderBy(asc(R.receiptDate), asc(R.receiptNumber));
  return {
    grandTotal,
    paidAmount: fromPaise(paidPaise),
    outstandingAmount: fromPaise(toPaise(grandTotal) - paidPaise),
    paymentStatus: billPaymentStatus(grandTotal, fromPaise(paidPaise)),
    history: history.map((h): BillPaymentHistoryRow => ({ ...h, amount: money(h.amount), paymentMode: h.paymentMode as PaymentMode, status: h.status as ReceiptStatus })),
  };
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
  const customerKey = normalizeMobile(body.customerMobile);
  if (!customerKey) throw validation('Select the customer', [{ path: ['customerMobile'], message: 'Select the customer' }]);

  return db.transaction(async (tx) => {
    await resolvePaymentAccount(tx, tenantId, body.accountId, body.paymentMode);

    // Locked in id order — the order every receipt uses, so overlapping receipts cannot deadlock.
    const billIds = Array.from(new Set(body.allocations.map((a) => a.billId))).sort();
    const locked = await tx
      .select({ id: B.id, billNumber: B.billNumber, billDate: B.billDate, grandTotal: B.grandTotal, mobileSearch: B.mobileSearch, bookNumber: schema.books.bookNumber })
      .from(B)
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .where(and(eq(B.tenantId, tenantId), inArray(B.id, billIds)))
      .orderBy(asc(B.id))
      .for('update', { of: B });
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
    const [customer] = await tx
      .select({ customerName: B.customerName, mobileNumber: B.mobileNumber })
      .from(B)
      .where(and(eq(B.tenantId, tenantId), eq(B.mobileSearch, customerKey)))
      .orderBy(desc(B.billDate), desc(B.createdAt))
      .limit(1);

    const receiptNumber = await allocateDocumentNumber(tx, tenantId, 'receipt');
    const amountPaise = body.allocations.reduce((s, a) => s + toPaise(a.amount), 0);
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
    await tx.insert(RA).values(body.allocations.map((a) => ({ tenantId, receiptId: receipt.id, billId: a.billId, amount: a.amount.toFixed(2) })));
    return receipt.id;
  });
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
    select 1 from receipt_allocations ra
    join bills b on b.id = ra.bill_id and b.tenant_id = ra.tenant_id
    join books bk on bk.id = b.book_id
    where ra.receipt_id = ${R.id} and ra.tenant_id = ${R.tenantId}
      and (${asNumber !== null ? sql`b.bill_number = ${asNumber}` : sql`(bk.book_number || '/' || b.bill_number) ilike ${`%${term}%`}`})
  )`;
  return or(
    ...(isNumber ? [] : [ilike(R.customerName, `%${term}%`), ilike(R.mobileNumber, `%${term}%`), ilike(A.accountName, `%${term}%`)]),
    ...(digits.length >= MIN_MOBILE_SEARCH_DIGITS ? [ilike(R.mobileSearch, `%${digits}%`)] : []),
    ...(asNumber !== null ? [eq(R.receiptNumber, asNumber)] : []),
    billMatch,
  );
}

