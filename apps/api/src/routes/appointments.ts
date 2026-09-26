import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { APPOINTMENT_VIEWS, WORK_EXPORT_MAX_ROWS, appointmentSchema, appointmentViewQuerySchema, normalizeMobile } from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { AppError, notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, tableColumns } from '../lib/filters';
import { logActivity } from '../services/activity';
import { appointmentRow, appointmentView, completeAppointment, createAppointment, reopenAppointment, shapeAppointment } from '../services/appointments';
import { businessToday } from '../services/company';
import { csvInteger, toCsv } from '../lib/csv';

/**
 * Appointment — the studio's booking record, and the customer information Billing will later
 * pick up instead of asking for it again.
 *
 * Hand-written rather than built on `crudRoutes` for three reasons the factory cannot express:
 * creation must take its number inside the insert's own transaction, the search spans an
 * integer column and a derived mobile key, and the default order is a composite one. Everything
 * else — the list query helpers, the permission check, the tenant predicate, the response
 * envelope and the audit entry — is the same machinery the factory uses, so the HTTP surface
 * matches the other modules exactly.
 */
const PERMISSION = 'operations_appointments';
const BASE = '/api/appointments';
const LABEL = 'Appointment';

const A = schema.appointments;

/** Below this, a digit string is a document number, not a phone fragment. */
const MIN_MOBILE_SEARCH_DIGITS = 4;
/** The `integer` column's ceiling — `appointment_number` cannot be compared past it. */
const INT4_MAX = 2147483647;

/**
 * The list / export search: the appointment number, the customer, the mobile (in whatever shape it
 * was typed) and the baby name. The ORDER comes from the view (`appointmentView`): ALL keeps the
 * historical "latest booking first", PENDING / TODAY / UPCOMING show the soonest first.
 */
function appointmentSearch(term: string | undefined) {
  if (!term) return undefined;
  const digits = normalizeMobile(term);
  const isNumber = /^\d+$/.test(term);
  // A digit string longer than the column can hold is a phone number, not an appointment
  // number — comparing it would ask Postgres to cast past `integer` and fail the request.
  const asNumber = isNumber && Number(term) <= INT4_MAX ? Number(term) : null;
  return or(
    // Text fields only when the operator typed something that is not just a number.
    ...(isNumber ? [] : [ilike(A.customerName, `%${term}%`), ilike(A.mobileNumber, `%${term}%`), ilike(A.babyName, `%${term}%`)]),
    ...(digits.length >= MIN_MOBILE_SEARCH_DIGITS ? [ilike(A.mobileSearch, `%${digits}%`)] : []),
    ...(asNumber !== null ? [eq(A.appointmentNumber, asNumber)] : []),
  );
}

export async function appointmentRoutes(app: FastifyInstance) {
  /**
   * List. Search covers the appointment number, the customer, the mobile (in whatever shape it
   * was typed) and the baby name.
   *
   * A term made only of digits is read as a number, not as text: it matches the appointment
   * number exactly, so "15" finds appointment 15 instead of every row whose phone number
   * happens to contain a 1 or a 5. Any term with at least four digits in it additionally
   * matches the normalized mobile, which is what lets "98765 43210" find "+91 98765 43210".
   */
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const cols = tableColumns(A);
    const matches = appointmentSearch(q.search);
    const f = parse(appointmentViewQuerySchema, req.query ?? {});
    const today = await businessToday(req.user.tenantId);
    const view = appointmentView(f.view, today, f.from, f.to);
    const base = and(eq(A.tenantId, req.user.tenantId), matches, filterWhere((req.query as Record<string, unknown>).filters, cols));
    const where = and(base, view.where);

    const [{ total }] = await db.select({ total: count() }).from(A).where(where);
    if (f.full && Number(total) > WORK_EXPORT_MAX_ROWS) throw new AppError('REPORT_TOO_LARGE', `This report has ${total} rows; print carries at most ${WORK_EXPORT_MAX_ROWS}. Narrow the filters and try again.`, 422);
    const order = q.sortBy && cols[q.sortBy] ? [sortBy(q.sortBy, q.sortOrder, cols, A.appointmentDate), desc(A.appointmentNumber)] : view.order;
    const rows = await db
      .select()
      .from(A)
      .where(where)
      .orderBy(...order)
      .limit(f.full ? WORK_EXPORT_MAX_ROWS : q.limit)
      .offset(f.full ? 0 : (q.page - 1) * q.limit);
    // Each view's size for its chip — same search and date range, no view narrowing.
    const counts = Object.fromEntries(
      await Promise.all(
        APPOINTMENT_VIEWS.map(async (v) => [v, Number((await db.select({ n: count() }).from(A).where(and(base, appointmentView(v, today, f.from, f.to).where)))[0].n)]),
      ),
    );
    return ok({ rows: rows.map(shapeAppointment), total: Number(total), page: q.page, pageSize: q.limit, today, counts }, `${LABEL}s retrieved successfully`);
  });

  /** CSV of the WHOLE filtered result (Reports -> Appointments), through the formula-safe `toCsv`. */
  app.get(`${BASE}/export`, { preHandler: app.requirePermission(PERMISSION) }, async (req, reply) => {
    const f = parse(appointmentViewQuerySchema, req.query ?? {});
    const term = typeof (req.query as { search?: unknown }).search === 'string' ? ((req.query as { search: string }).search.trim() || undefined) : undefined;
    const today = await businessToday(req.user.tenantId);
    const view = appointmentView(f.view, today, f.from, f.to);
    const where = and(eq(A.tenantId, req.user.tenantId), appointmentSearch(term), view.where);
    const [{ total }] = await db.select({ total: count() }).from(A).where(where);
    if (Number(total) > WORK_EXPORT_MAX_ROWS) throw new AppError('REPORT_TOO_LARGE', `This report has ${total} rows; export carries at most ${WORK_EXPORT_MAX_ROWS}. Narrow the filters and try again.`, 422);
    const rows = await db.select().from(A).where(where).orderBy(...view.order).limit(WORK_EXPORT_MAX_ROWS);
    const csv = toCsv(
      ['Appointment No', 'Date', 'Time', 'Customer', 'Mobile', 'Baby', 'Status', 'Done At', 'Remark', 'From Next Visit'],
      rows.map((r) => [
        csvInteger(r.appointmentNumber),
        r.appointmentDate,
        r.appointmentTime ? r.appointmentTime.slice(0, 5) : null,
        r.customerName,
        r.mobileNumber,
        r.babyName,
        r.completedAt ? 'Done' : 'Pending',
        r.completedAt ? r.completedAt.toISOString() : null,
        r.remark,
        r.sourceBillId ? 'Yes' : 'No',
      ]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="Appointments-${f.view.toLowerCase()}-${today}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });

  /** Done — one click, no form. Idempotent. The appointment stays, under Done / All. */
  app.post(`${BASE}/:id/done`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const { row, changed } = await completeAppointment(req.user.tenantId, req.user.id, id);
    if (changed) await logActivity(req, 'appointment', row.id, 'appointment_done', `${LABEL} #${row.appointmentNumber} for "${row.customerName}" marked done`);
    return ok(shapeAppointment(row), changed ? `${LABEL} #${row.appointmentNumber} done` : `${LABEL} #${row.appointmentNumber} was already done`);
  });

  /** Back to Pending — correcting a mistaken Done. */
  app.post(`${BASE}/:id/reopen`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const { row, changed } = await reopenAppointment(req.user.tenantId, id);
    if (changed) await logActivity(req, 'appointment', row.id, 'appointment_reopened', `${LABEL} #${row.appointmentNumber} for "${row.customerName}" reopened`);
    return ok(shapeAppointment(row), `${LABEL} #${row.appointmentNumber} is pending again`);
  });

  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(A).where(and(eq(A.id, id), eq(A.tenantId, req.user.tenantId)));
    if (!row) throw notFound(LABEL);
    return ok(shapeAppointment(row));
  });

  /** The number is taken inside the insert's transaction — see `services/appointments.ts`. */
  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(appointmentSchema, req.body);
    const created = await createAppointment(req.user.tenantId, body);
    await logActivity(req, 'appointment', created.id, 'created', `${LABEL} #${created.appointmentNumber} for "${created.customerName}" created`);
    return ok(created, `${LABEL} #${created.appointmentNumber} created successfully`);
  });

  /**
   * The business fields are editable; the appointment number is not. `appointmentSchema` has no
   * such field, so a payload carrying one loses it in validation and never reaches a column.
   */
  app.put(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(A).where(and(eq(A.id, id), eq(A.tenantId, req.user.tenantId)));
    if (!existing) throw notFound(LABEL);
    const body = parse(appointmentSchema.partial(), req.body);
    const row = appointmentRow(body);
    if (!Object.keys(row).length) throw validation('Nothing to update');
    const [updated] = await db.update(A).set({ ...row, updatedAt: new Date() }).where(eq(A.id, id)).returning();
    await logActivity(req, 'appointment', updated.id, 'updated', `${LABEL} #${updated.appointmentNumber} for "${updated.customerName}" updated`, { changed: Object.keys(row) });
    return ok(shapeAppointment(updated), `${LABEL} updated successfully`);
  });

  /**
   * Deletable while nothing references an appointment — bills do not exist yet. When they do,
   * the bill will carry its own customer snapshot plus an optional `appointmentId`, so deleting
   * a booking must never be allowed to rewrite or break an issued bill.
   */
  app.delete(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(A).where(and(eq(A.id, id), eq(A.tenantId, req.user.tenantId)));
    if (!existing) throw notFound(LABEL);
    await db.delete(A).where(eq(A.id, id));
    await logActivity(req, 'appointment', id, 'deleted', `${LABEL} #${existing.appointmentNumber} for "${existing.customerName}" deleted`);
    return ok(null, `${LABEL} deleted successfully`);
  });

  /**
   * Mobile lookup — the contract the future Billing screen will use to find the customer it is
   * about to bill. It matches on the normalized key, so the operator may type the number in any
   * of the shapes it was ever entered in.
   *
   * It returns CANDIDATES, most recent first, and never picks one: the same mobile legitimately
   * has many bookings, and only the operator knows which one is being billed.
   *
   * Tenant-scoped and permission-guarded like the list — an appointment carries a customer's
   * name and number, which is not something every authenticated user may search by mobile.
   */
  app.get('/api/common/lookups/appointments', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { mobile } = req.query as { mobile?: string };
    const digits = normalizeMobile(mobile);
    // A lookup with no number is not a request for the whole book of appointments.
    if (!digits) return ok([]);
    const rows = await db
      .select({
        id: A.id,
        appointmentNumber: A.appointmentNumber,
        appointmentDate: A.appointmentDate,
        appointmentTime: A.appointmentTime,
        customerName: A.customerName,
        mobileNumber: A.mobileNumber,
        babyName: A.babyName,
      })
      .from(A)
      .where(and(eq(A.tenantId, req.user.tenantId), eq(A.mobileSearch, digits)))
      .orderBy(desc(A.appointmentDate), desc(A.appointmentNumber))
      .limit(20);
    return ok(rows.map(shapeAppointment));
  });
}
