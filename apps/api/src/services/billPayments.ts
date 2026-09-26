import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';

/**
 * A bill's Paid — the ONE definition, used by the bill list, the pending bills, the receipt's
 * overpayment check and the bill edit guard (docs/RECEIPTS_PAYMENTS.md):
 *
 *     Paid        = SUM(allocations on ACTIVE receipts)
 *     Outstanding = Grand Total - Paid
 *
 * Nothing stores either figure. A cancelled receipt's allocations stay in the table, as history,
 * and simply stop matching the ACTIVE predicate below.
 *
 * Kept apart from `services/receipts.ts` so `services/bills.ts` can use it without an import cycle.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const B = schema.bills;
const R = schema.receipts;
const RA = schema.receiptAllocations;

/**
 * Paid per bill, in exact integer paise. Summed and scaled in SQL, so no float ever touches it:
 * `numeric * 100` is whole, and every figure the schemas allow stays far below 2^53 paise.
 * Bills with nothing received are simply absent from the map.
 */
export async function paidPaiseByBill(exec: Executor, tenantId: string, billIds: string[]): Promise<Map<string, number>> {
  if (!billIds.length) return new Map();
  const rows = await exec
    .select({ billId: RA.billId, paise: sql<string>`(sum(${RA.amount}) * 100)::bigint::text` })
    .from(RA)
    .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
    .where(and(eq(RA.tenantId, tenantId), inArray(RA.billId, billIds), eq(R.status, 'ACTIVE')))
    .groupBy(RA.billId);
  return new Map(rows.map((r) => [r.billId, Number(r.paise)]));
}

/** True when ANY receipt — active or cancelled — ever allocated to this bill. That history is what protects it from deletion. */
export async function billHasAllocations(exec: Executor, tenantId: string, billId: string) {
  const [row] = await exec.select({ id: RA.id }).from(RA).where(and(eq(RA.tenantId, tenantId), eq(RA.billId, billId))).limit(1);
  return !!row;
}

/**
 * Paid per bill as a grouped subquery a list can LEFT JOIN — one aggregate for the whole query,
 * never a query per row. Scoped to the tenant inside, so it aggregates only that tenant's rows.
 *
 * `asOf` ("YYYY-MM-DD", the receivables reports) counts only receipts dated on or before it. It is
 * still the same definition — ACTIVE allocations — narrowed by receipt date; a receipt cancelled
 * since counts nowhere, whatever its date (docs/RECEIVABLES_REPORTS.md, "As of").
 */
export const paidSubquery = (tenantId: string, asOf?: string) =>
  db
    .select({ billId: RA.billId, paid: sql<string>`sum(${RA.amount})`.as('paid') })
    .from(RA)
    .innerJoin(R, and(eq(R.id, RA.receiptId), eq(R.tenantId, RA.tenantId)))
    .where(and(eq(RA.tenantId, tenantId), eq(R.status, 'ACTIVE'), asOf ? lte(R.receiptDate, asOf) : undefined))
    .groupBy(RA.billId)
    .as('bill_paid');

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
