import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { billSchema, billUpdateSchema, normalizeMobile } from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { notFound } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, tableColumns, type ColumnMap } from '../lib/filters';
import { logActivity } from '../services/activity';
import { createBill, getBill, shapeBill, updateBill } from '../services/bills';

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

/** Below this, a digit string is a document number, not a phone fragment. */
const MIN_MOBILE_SEARCH_DIGITS = 4;
/** The `integer` column's ceiling — `bill_number` cannot be compared past it. */
const INT4_MAX = 2147483647;

export async function billRoutes(app: FastifyInstance) {
  /**
   * List. One left join carries each bill's book number, so the list never runs a query per
   * row, and the book number is searchable, sortable and filterable like the bill's own
   * columns.
   *
   * Search covers the bill number, the customer, the mobile (in whatever shape it was typed)
   * and the book. A term made only of digits is read as a bill number, so "25" finds Bill 25
   * rather than every customer whose phone contains a 2 or a 5; a term with at least four
   * digits additionally matches the normalized mobile key.
   */
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const cols: ColumnMap = { ...tableColumns(B), bookNumber: schema.books.bookNumber };
    const term = q.search;
    const digits = term ? normalizeMobile(term) : '';
    const isNumber = !!term && /^\d+$/.test(term);
    const asNumber = isNumber && Number(term) <= INT4_MAX ? Number(term) : null;
    const matches = term
      ? or(
          ...(isNumber ? [] : [ilike(B.customerName, `%${term}%`), ilike(B.mobileNumber, `%${term}%`), ilike(B.babyName, `%${term}%`)]),
          ilike(schema.books.bookNumber, `%${term}%`),
          ...(digits.length >= MIN_MOBILE_SEARCH_DIGITS ? [ilike(B.mobileSearch, `%${digits}%`)] : []),
          ...(asNumber !== null ? [eq(B.billNumber, asNumber)] : []),
        )
      : undefined;
    const where = and(eq(B.tenantId, req.user.tenantId), matches, filterWhere((req.query as Record<string, unknown>).filters, cols));

    const [{ total }] = await db.select({ total: count() }).from(B).innerJoin(schema.books, eq(schema.books.id, B.bookId)).where(where);
    /** Operational default: the latest bill date first, and the bill number as the stable tie-breaker. */
    const order = q.sortBy && cols[q.sortBy] ? [sortBy(q.sortBy, q.sortOrder, cols, B.billDate), desc(B.billNumber)] : [desc(B.billDate), desc(B.billNumber)];
    const rows = await db
      .select({ ...tableColumns(B), bookNumber: schema.books.bookNumber })
      .from(B)
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .where(where)
      .orderBy(...order)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    // `tableColumns` is an untyped column map, so the row's `numeric` fields arrive as unknown;
    // `shapeBill` is what turns them into numbers, exactly as the detail endpoint does.
    const shaped = (rows as unknown as { subTotal: unknown; gstAmount: unknown; grandTotal: unknown }[]).map(shapeBill);
    return ok({ rows: shaped, total: Number(total), page: q.page, pageSize: q.limit }, `${LABEL}s retrieved successfully`);
  });

  /** One bill with its book number, its booking's number and its lines in print order. */
  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    return ok(await getBill(req.user.tenantId, id));
  });

  /**
   * Create. The bill number is taken inside the same transaction that inserts the bill and its
   * lines — see `services/bills.ts`. Opening the form allocates nothing; only a successful
   * save does.
   */
  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(billSchema, req.body);
    const created = await createBill(req.user.tenantId, body);
    await logActivity(req, 'bill', created.id, 'created', `${LABEL} ${created.bookNumber}/${created.billNumber} for "${created.customerName}" created`, { grandTotal: created.grandTotal });
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
    const updated = await updateBill(req.user.tenantId, id, body);
    await logActivity(req, 'bill', updated.id, 'updated', `${LABEL} ${updated.bookNumber}/${updated.billNumber} for "${updated.customerName}" updated`, { grandTotal: updated.grandTotal });
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
    const [existing] = await db
      .select({ id: B.id, billNumber: B.billNumber, customerName: B.customerName, bookNumber: schema.books.bookNumber })
      .from(B)
      .innerJoin(schema.books, eq(schema.books.id, B.bookId))
      .where(and(eq(B.id, id), eq(B.tenantId, req.user.tenantId)))
      .limit(1);
    if (!existing) throw notFound(LABEL);
    await db.delete(B).where(and(eq(B.id, id), eq(B.tenantId, req.user.tenantId)));
    await logActivity(req, 'bill', id, 'deleted', `${LABEL} ${existing.bookNumber}/${existing.billNumber} for "${existing.customerName}" deleted`);
    return ok(null, `${LABEL} deleted successfully`);
  });
}
