import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { db, schema } from '../db/client';

/**
 * A bill's Paid — the ONE definition, used by the bill list, the pending bills, the receipt's
 * overpayment check, advance application, the bill edit guard and every receivables report
 * (docs/RECEIPTS_PAYMENTS.md, docs/ADVANCE_PAYMENTS.md):
 *
 *     Paid        = SUM(allocations on ACTIVE receipts)
 *                 + SUM(ACTIVE advance applications on ACTIVE receipts)
 *     Outstanding = Grand Total - Paid
 *
 * Nothing stores either figure. A cancelled receipt's allocations, and a reversed application, stay
 * in their tables as history and simply stop matching the ACTIVE predicates below. A receipt's
 * UNAPPLIED advance is in neither table, so it reduces no bill until someone applies it.
 *
 * Kept apart from `services/receipts.ts` so `services/bills.ts` can use it without an import cycle.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const R = schema.receipts;
const RA = schema.receiptAllocations;
const AA = schema.advanceApplications;
const B = schema.bills;

/**
 * Every settlement that counts towards Paid, as (bill_id, amount) rows: allocations, dated by their
 * receipt, and applications, dated by the day they were applied. `asOf` ("YYYY-MM-DD", the
 * receivables reports) keeps only what was settled on or before it; a cancelled receipt or a
 * reversed application counts nowhere, whatever its date (docs/RECEIVABLES_REPORTS.md, "As of").
 */
function settlements(exec: Executor, tenantId: string, asOf?: string, billIds?: string[]) {
  return unionAll(
    exec
      .select({ billId: RA.billId, amount: RA.amount })
      .from(RA)
      .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
      .where(and(eq(RA.tenantId, tenantId), eq(R.status, 'ACTIVE'), asOf ? lte(R.receiptDate, asOf) : undefined, billIds ? inArray(RA.billId, billIds) : undefined)),
    exec
      .select({ billId: AA.billId, amount: AA.amount })
      .from(AA)
      .innerJoin(R, and(eq(R.id, AA.receiptId), eq(R.tenantId, AA.tenantId)))
      .where(and(eq(AA.tenantId, tenantId), eq(AA.status, 'ACTIVE'), eq(R.status, 'ACTIVE'), asOf ? lte(AA.appliedOn, asOf) : undefined, billIds ? inArray(AA.billId, billIds) : undefined)),
  ).as('settlements');
}

/**
 * Paid per bill, in exact integer paise. Summed and scaled in SQL, so no float ever touches it:
 * `numeric * 100` is whole, and every figure the schemas allow stays far below 2^53 paise.
 * Bills with nothing received are simply absent from the map.
 */
export async function paidPaiseByBill(exec: Executor, tenantId: string, billIds: string[]): Promise<Map<string, number>> {
  if (!billIds.length) return new Map();
  const s = settlements(exec, tenantId, undefined, billIds);
  const rows = await exec
    .select({ billId: s.billId, paise: sql<string>`(sum(${s.amount}) * 100)::bigint::text` })
    .from(s)
    .groupBy(s.billId);
  return new Map(rows.map((r) => [r.billId, Number(r.paise)]));
}

/**
 * True when ANY money — an allocation of an active or cancelled receipt, or an applied advance,
 * reversed or not — ever touched this bill. That history is what protects it from deletion.
 */
export async function billHasAllocations(exec: Executor, tenantId: string, billId: string) {
  const [alloc] = await exec.select({ id: RA.id }).from(RA).where(and(eq(RA.tenantId, tenantId), eq(RA.billId, billId))).limit(1);
  if (alloc) return true;
  const [applied] = await exec.select({ id: AA.id }).from(AA).where(and(eq(AA.tenantId, tenantId), eq(AA.billId, billId))).limit(1);
  return !!applied;
}

/**
 * Paid per bill as a grouped subquery a list can LEFT JOIN — one aggregate for the whole query,
 * never a query per row. Scoped to the tenant inside, so it aggregates only that tenant's rows.
 */
export const paidSubquery = (tenantId: string, asOf?: string) => {
  const s = settlements(db, tenantId, asOf);
  return db
    .select({ billId: s.billId, paid: sql<string>`sum(${s.amount})`.as('paid') })
    .from(s)
    .groupBy(s.billId)
    .as('bill_paid');
};

/**
 * Paid, Outstanding and Payment Status as SQL over a bill row joined to `paidSubquery` — so they
 * can be selected, filtered and sorted like columns. The status follows `billPaymentStatus` in
 * `@erp/shared` exactly: nothing outstanding is PAID (a zero-total bill included), nothing paid is
 * UNPAID, anything else is PARTIALLY_PAID.
 */
export function paymentColumns(paid: ReturnType<typeof paidSubquery>) {
  const paidAmount = sql<string>`coalesce(${paid.paid}, 0)`;
  const outstandingAmount = sql<string>`(${B.grandTotal} - coalesce(${paid.paid}, 0))`;
  const paymentStatus = sql<string>`(case when ${B.grandTotal} - coalesce(${paid.paid}, 0) <= 0 then 'PAID' when coalesce(${paid.paid}, 0) = 0 then 'UNPAID' else 'PARTIALLY_PAID' end)`;
  return { paidAmount, outstandingAmount, paymentStatus };
}

/**
 * A receipt's advance still available, as SQL over a `receipts` row: its amount minus its
 * allocations minus its ACTIVE applications — 0 once it is cancelled. Correlated, for the receipt
 * list's one page; `customerAdvance` sums the same expression per customer.
 */
export const receiptAppliedSql = sql<string>`(
  coalesce((select sum(ra.amount) from receipt_allocations ra where ra.receipt_id = ${R.id} and ra.tenant_id = ${R.tenantId}), 0)
  + coalesce((select sum(aa.amount) from advance_applications aa where aa.receipt_id = ${R.id} and aa.tenant_id = ${R.tenantId} and aa.status = 'ACTIVE'), 0)
)`;
export const receiptAvailableSql = sql<string>`(case when ${R.status} = 'ACTIVE' then ${R.amount} - ${receiptAppliedSql} else 0 end)`;
