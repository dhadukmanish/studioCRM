import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { billSchema, billUpdateSchema } from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, tableColumns, type ColumnMap } from '../lib/filters';
import { logActivity } from '../services/activity';
import { billSearch, createBill, deleteBill, getBill, resolveDefaultBook, shapeBill, updateBill } from '../services/bills';
import type { NextVisitResult } from '../services/nextVisit';
import { paidSubquery, paymentColumns } from '../services/billPayments';
import { getBillPayments } from '../services/receipts';
import { auditRevokedLinks } from '../services/publicInvoiceLinks';

/**
 * Billing — the studio's invoice document.
 *
 * Hand-written rather than built on `crudRoutes` for the same reasons Appointments is: a bill
 * is created inside a transaction that also takes its number and writes its lines, its search
 * spans an integer column, a derived mobile key and the joined book number, and its default
 * order is a composite one. Everything else — the list query helpers, the permission check,
 * the tenant predicate, the response envelope and the audit entry — is the machinery the
 * factory uses, so the HTTP surface matches every other module.
 *
 * The business rules live in `services/bills.ts`; this file validates, authorizes and reports.
 */
const PERMISSION = 'operations_billing';
const BASE = '/api/bills';
const LABEL = 'Bill';

const B = schema.bills;

export async function billRoutes(app: FastifyInstance) {
  /**
   * List. One left join carries each bill's book number, so the list never runs a query per
   * row, and the book number is searchable, sortable and filterable like the bill's own
   * columns.
   *
   * Search covers the bill number, the customer, the mobile and the book (`billSearch`).
   */
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    // Paid / Outstanding / Payment Status come from ONE grouped aggregate LEFT JOINed to the page
    // query — never stored on the bill, never a query per row — and filter and sort like columns.
    const paid = paidSubquery(req.user.tenantId);
    const payment = paymentColumns(paid);
    const cols: ColumnMap = { ...tableColumns(B), bookNumber: schema.books.bookNumber, ...payment };
    // Paid / Outstanding are SQL expressions, which `filterWhere` would compare as text (and a
    // non-numeric value would fail the query) — so they sort but do not filter. Payment Status,
    // a text value, filters normally.
    const { paidAmount: _p, outstandingAmount: _o, ...filterCols } = cols;
    const where = and(eq(B.tenantId, req.user.tenantId), billSearch(q.search), filterWhere((req.query as Record<string, unknown>).filters, filterCols));

    const [{ total }] = await db.select({ total: count() }).from(B).innerJoin(schema.books, eq(schema.books.id, B.bookId)).leftJoin(paid, eq(paid.billId, B.id)).where(where);
    /** Operational default: the latest bill date first, and the bill number as the stable tie-breaker. */
    const order = q.sortBy && cols[q.sortBy] ? [sortBy(q.sortBy, q.sortOrder, cols, B.billDate), desc(B.billNumber)] : [desc(B.billDate), desc(B.billNumber)];
    const rows = await db
      .select({ ...tableColumns(B), bookNumber: schema.books.bookNumber, ...payment })
      .from(B)
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .leftJoin(paid, eq(paid.billId, B.id))
      .where(where)
      .orderBy(...order)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    // `tableColumns` is an untyped column map, so the row's `numeric` fields arrive as unknown;
    // `shapeBill` is what turns them into numbers, exactly as the detail endpoint does.
    const shaped = (rows as unknown as { subTotal: unknown; discountValue: unknown; discountAmount: unknown; gstAmount: unknown; grandTotal: unknown; paidAmount: unknown; outstandingAmount: unknown }[]).map((r) => ({
      ...shapeBill(r),
      paidAmount: Number(r.paidAmount),
      outstandingAmount: Number(r.outstandingAmount),
    }));
    return ok({ rows: shaped, total: Number(total), page: q.page, pageSize: q.limit }, `${LABEL}s retrieved successfully`);
  });

  /**
   * The Book a new bill opens with (`resolveDefaultBook`): the only active book, else the configured
   * default, else the last-used one, else a stable first. A suggestion only — it takes no number.
   */
  app.get(`${BASE}/default-book`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => ok(await resolveDefaultBook(req.user.tenantId)));

  /** One bill with its book number, its booking's number and its lines in print order. */
  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    return ok(await getBill(req.user.tenantId, id));
  });

  /**
   * The bill's payment position and history — every receipt that ever settled it, cancelled ones
   * shown as cancelled. Billing read is enough: what a bill has been paid is part of the bill.
   */
  app.get(`${BASE}/:id/payments`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    return ok(await getBillPayments(req.user.tenantId, id));
  });

  /**
   * Create. The bill number is taken inside the same transaction that inserts the bill and its
   * lines — see `services/bills.ts`. Opening the form allocates nothing; only a successful
   * save does.
   */
  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(billSchema, req.body);
    const { bill: created, nextVisit } = await createBill(req.user.tenantId, body);
    await logActivity(req, 'bill', created.id, 'created', `${LABEL} ${created.bookNumber}/${created.billNumber} for "${created.customerName}" created`, { grandTotal: created.grandTotal });
    await auditNextVisit(req, `${created.bookNumber}/${created.billNumber}`, nextVisit);
    return ok(created, `${LABEL} No. ${created.billNumber} created successfully`);
  });

  /**
   * Update the header and replace the lines, atomically.
   *
   * The book and the bill number are not editable: `billUpdateSchema` has no field for either,
   * so a payload carrying them loses it in validation and no edit can renumber a bill or move
   * a book's counter.
   */
  app.put(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(billUpdateSchema, req.body);
    const { bill: updated, revokedLinkIds, nextVisit } = await updateBill(req.user.tenantId, id, body);
    await logActivity(req, 'bill', updated.id, 'updated', `${LABEL} ${updated.bookNumber}/${updated.billNumber} for "${updated.customerName}" updated`, { grandTotal: updated.grandTotal });
    await auditRevokedLinks(req, updated.id, `${updated.bookNumber}/${updated.billNumber}`, revokedLinkIds, 'BILL_UPDATED');
    await auditNextVisit(req, `${updated.bookNumber}/${updated.billNumber}`, nextVisit);
    return ok(updated, `${LABEL} updated successfully`);
  });

  /**
   * Delete. The lines go with the bill (`bill_items_bill_tenant_fk` is ON DELETE CASCADE).
   *
   * The book's counter is deliberately NOT rewound. A number that has been issued is spent:
   * if Bill No. 25 is deleted, the next bill is still 26, and 25 simply no longer exists.
   * Rewinding would hand a second document the same identity as one that was already printed,
   * given out or filed. There is no code path anywhere that lowers `books.next_bill_number`.
   */
  app.delete(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    // Refused with 409 BILL_HAS_PAYMENTS once any receipt has settled the bill — payment history,
    // even a cancelled receipt's, is never deleted with it.
    const existing = await deleteBill(req.user.tenantId, id);
    await logActivity(req, 'bill', id, 'deleted', `${LABEL} ${existing.bookNumber}/${existing.billNumber} for "${existing.customerName}" deleted`);
    return ok(null, `${LABEL} deleted successfully`);
  });
}

/** The next-visit appointment a bill save created, moved or detached — on the appointment's own trail. */
async function auditNextVisit(req: FastifyRequest, billLabel: string, r: NextVisitResult) {
  if (!r.action || !r.appointment) return;
  const what = { created: 'created from', moved: 'moved by', detached: 'detached from' }[r.action];
  await logActivity(req, 'appointment', r.appointment.id, r.action === 'created' ? 'created' : 'updated', `Appointment #${r.appointment.appointmentNumber} ${what} Bill ${billLabel} (next visit)`);
}
