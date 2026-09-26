import { and, asc, count, desc, eq, gte, ilike, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias, unionAll } from 'drizzle-orm/pg-core';
import {
  DELIVERY_VIEWS,
  WORK_EXPORT_MAX_ROWS,
  WORK_STAGES,
  WORK_STAGE_LABELS,
  fromPaise,
  normalizeMobile,
  toPaise,
  workPosition,
  type BillPaymentStatus,
  type BillWorkStatus,
  type DeliveryReport,
  type DeliveryView,
  type WorkPosition,
  type WorkQueue,
  type WorkView,
  type WorkStage,
  type WorkStageOutcome,
} from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError, notFound, validation } from '../lib/errors';
import { paidSubquery, paymentColumns } from './billPayments';
import { availableAdvanceByCustomer } from './receipts';
import { billSearch } from './bills';
import { businessToday } from './company';

/**
 * The studio workflow (docs/STUDIO_WORKFLOW.md): Selection -> Editing -> WhatsApp -> Delivery.
 *
 * A stage is a row in `bill_work_stages` (DONE or SKIPPED) or nothing. The job's position — the one
 * thing the staff member needs, "what do I do next?" — is DERIVED from those rows by `workPositionSql`,
 * the SQL twin of `workPosition` in `@erp/shared`. No status is stored, so none can drift.
 *
 * Operational only: nothing here reads or writes money. Delivered never means Paid; the payment
 * columns shown next to a job are the receipts' derived position (`paymentColumns`).
 */

const B = schema.bills;
const BK = schema.books;
const A = schema.appointments;
const WS = schema.billWorkStages;
const completedUser = alias(schema.users, 'work_completed_by');

/** Per bill, the outcome recorded for each stage (NULL = nothing recorded) and the delivered date — ONE grouped subquery. */
export const workSubquery = (tenantId: string) => {
  const outcome = (s: WorkStage) => sql<WorkStageOutcome | null>`max(${WS.outcome}) filter (where ${WS.stage} = ${s})`;
  return db
    .select({
      billId: WS.billId,
      selection: outcome('SELECTION').as('selection'),
      editing: outcome('EDITING').as('editing'),
      whatsapp: outcome('WHATSAPP').as('whatsapp'),
      delivery: outcome('DELIVERY').as('delivery'),
      deliveredOn: sql<string | null>`max(${WS.completedOn}) filter (where ${WS.stage} = 'DELIVERY' and ${WS.outcome} = 'DONE')`.as('delivered_on'),
      deliveredAt: sql<Date | string | null>`max(${WS.completedAt}) filter (where ${WS.stage} = 'DELIVERY')`.as('delivered_at'),
    })
    .from(WS)
    .where(eq(WS.tenantId, tenantId))
    .groupBy(WS.billId)
    .as('work');
};

/** `workPosition` in SQL: Delivery recorded closes the job; otherwise the stage after the furthest one recorded. */
export const workPositionSql = (w: ReturnType<typeof workSubquery>) =>
  sql<WorkPosition>`(case when ${w.delivery} is not null then 'COMPLETE' when ${w.whatsapp} is not null then 'DELIVERY' when ${w.editing} is not null then 'WHATSAPP' when ${w.selection} is not null then 'EDITING' else 'SELECTION' end)`;

/* ------------------------------------------------------------ one job -- */

async function billOf(tenantId: string, billId: string) {
  const [bill] = await db
    .select({ id: B.id, deliveryDate: B.deliveryDate, bookNumber: BK.bookNumber, billNumber: B.billNumber })
    .from(B)
    .innerJoin(BK, eq(BK.id, B.bookId))
    .where(and(eq(B.id, billId), eq(B.tenantId, tenantId)))
    .limit(1);
  if (!bill) throw notFound('Bill');
  return bill;
}

export async function getBillWork(tenantId: string, billId: string): Promise<BillWorkStatus> {
  const bill = await billOf(tenantId, billId);
  const rows = await db
    .select({
      stage: WS.stage,
      outcome: WS.outcome,
      completedOn: WS.completedOn,
      completedAt: WS.completedAt,
      completedByName: sql<string | null>`nullif(btrim(${completedUser.firstName} || ' ' || ${completedUser.lastName}), '')`,
    })
    .from(WS)
    .leftJoin(completedUser, eq(completedUser.id, WS.completedBy))
    .where(and(eq(WS.tenantId, tenantId), eq(WS.billId, billId)));
  const stages = WORK_STAGES.flatMap((s) => rows.filter((r) => r.stage === s)).map((r) => ({
    ...r,
    stage: r.stage as WorkStage,
    outcome: r.outcome as WorkStageOutcome,
    completedAt: r.completedAt.toISOString(),
  }));
  const recorded = Object.fromEntries(stages.map((s) => [s.stage, s.outcome])) as Partial<Record<WorkStage, WorkStageOutcome>>;
  return { billId, position: workPosition(recorded), stages, plannedDelivery: bill.deliveryDate };
}

/**
 * Record a stage — one click. Idempotent: recording what is already recorded changes nothing (the
 * original time and person stay), and the unique key means two clicks at once cannot record it
 * twice. Recording a different outcome (a skipped stage later done) replaces it.
 *
 * WhatsApp is DONE only through `viaShare` — the share dialog actually opening WhatsApp. By hand it
 * can only be skipped: the app never claims a message it did not open.
 */
export async function recordStage(tenantId: string, userId: string, billId: string, stage: WorkStage, outcome: WorkStageOutcome, viaShare = false) {
  if (stage === 'WHATSAPP' && outcome === 'DONE' && !viaShare) throw validation('WhatsApp is marked done by sharing on WhatsApp. Use Skip if it is not needed for this job.');
  const bill = await billOf(tenantId, billId);
  const completedOn = await businessToday(tenantId);
  const now = new Date();
  const changed = await db
    .insert(WS)
    .values({ tenantId, billId, stage, outcome, completedOn, completedAt: now, completedBy: userId })
    .onConflictDoUpdate({
      target: [WS.tenantId, WS.billId, WS.stage],
      set: { outcome, completedOn, completedAt: now, completedBy: userId, updatedAt: now },
      setWhere: sql`${WS.outcome} <> excluded.outcome`,
    })
    .returning({ id: WS.id });
  return { changed: changed.length > 0, billLabel: `${bill.bookNumber}/${bill.billNumber}` };
}

/** Reopen a recorded stage: its row goes, so the job is back at (or before) that stage. The activity log keeps the history. */
export async function reopenStage(tenantId: string, billId: string, stage: WorkStage) {
  const bill = await billOf(tenantId, billId);
  const gone = await db
    .delete(WS)
    .where(and(eq(WS.tenantId, tenantId), eq(WS.billId, billId), eq(WS.stage, stage)))
    .returning({ outcome: WS.outcome });
  if (!gone.length) throw new AppError('WORK_STAGE_NOT_RECORDED', `${WORK_STAGE_LABELS[stage]} is not recorded on this bill`, 409);
  return { billLabel: `${bill.bookNumber}/${bill.billNumber}` };
}

/* ---------------------------------------------------------------- queue -- */

/**
 * Today's Work (`WORK_VIEWS` in `@erp/shared`): appointments and jobs in ONE list, each at the one
 * thing to do next, in urgency buckets —
 *
 *   1 overdue: a pending appointment before today, or a job whose PROMISED delivery date has passed
 *   2 a pending appointment today            3 a delivery promised for today
 *   4 a job under way (a step recorded) or billed today
 *   5 dated after today                      6 a job not started and not dated (Pending only)
 *   9 finished (Completed only)
 *
 * Today = buckets 1–4, Pending = 1–6, Upcoming = anything unfinished dated after today, Completed = 9.
 * A job is dated by its promised delivery; only a promised date can make it overdue. A search on
 * Today looks through everything unfinished. Payment and advance are the receipts' derived figures.
 */
export async function workQueue(
  tenantId: string,
  opts: { view: WorkView; search?: string; page: number; limit: number; appointments: boolean; money: boolean },
): Promise<WorkQueue> {
  const today = await businessToday(tenantId);
  const paid = paidSubquery(tenantId);
  const { outstandingAmount, paymentStatus } = paymentColumns(paid);
  const w = workSubquery(tenantId);
  const position = workPositionSql(w);
  const underWay = sql`coalesce(${w.selection}, ${w.editing}, ${w.whatsapp}) is not null`;

  const appointmentRows = db
    .select({
      kind: sql<'APPOINTMENT' | 'BILL'>`'APPOINTMENT'`.as('kind'),
      id: sql<string>`${A.id}`.as('id'),
      reference: sql<string>`'#' || ${A.appointmentNumber}`.as('reference'),
      customerName: sql<string>`${A.customerName}`.as('customer_name'),
      mobileNumber: sql<string>`${A.mobileNumber}`.as('mobile_number'),
      mobileSearch: sql<string>`${A.mobileSearch}`.as('mobile_search'),
      babyName: sql<string | null>`${A.babyName}`.as('baby_name'),
      next: sql<string>`(case when ${A.completedAt} is null then 'APPOINTMENT' else 'COMPLETE' end)`.as('next'),
      dueDate: sql<string>`${A.appointmentDate}::text`.as('due_date'),
      dueTime: sql<string | null>`to_char(${A.appointmentTime}, 'HH24:MI')`.as('due_time'),
      overdue: sql<boolean>`(${A.completedAt} is null and ${A.appointmentDate} < ${today}::date)`.as('overdue'),
      billDate: sql<string | null>`null::text`.as('bill_date'),
      plannedDelivery: sql<string | null>`null::text`.as('planned_delivery'),
      completedAt: sql<Date | string | null>`${A.completedAt}`.as('completed_at'),
      deliveryOutcome: sql<string | null>`null::text`.as('delivery_outcome'),
      paymentStatus: sql<string | null>`null::text`.as('payment_status'),
      outstandingAmount: sql<string | null>`null::numeric`.as('outstanding_amount'),
      bucket: sql<number>`(case when ${A.completedAt} is not null then 9 when ${A.appointmentDate} < ${today}::date then 1 when ${A.appointmentDate} = ${today}::date then 2 else 5 end)`.as('bucket'),
      upcoming: sql<boolean>`(${A.completedAt} is null and ${A.appointmentDate} > ${today}::date)`.as('upcoming'),
      seq: sql<number>`${A.appointmentNumber}`.as('seq'),
    })
    .from(A)
    .where(and(eq(A.tenantId, tenantId), opts.appointments ? undefined : sql`false`));

  const billRows = db
    .select({
      kind: sql<'APPOINTMENT' | 'BILL'>`'BILL'`.as('kind'),
      id: sql<string>`${B.id}`.as('id'),
      reference: sql<string>`${BK.bookNumber} || '/' || ${B.billNumber}`.as('reference'),
      customerName: sql<string>`${B.customerName}`.as('customer_name'),
      mobileNumber: sql<string>`${B.mobileNumber}`.as('mobile_number'),
      mobileSearch: sql<string>`${B.mobileSearch}`.as('mobile_search'),
      babyName: sql<string | null>`${B.babyName}`.as('baby_name'),
      next: sql<string>`${position}`.as('next'),
      dueDate: sql<string>`coalesce(${B.deliveryDate}, ${B.billDate})::text`.as('due_date'),
      dueTime: sql<string | null>`null::text`.as('due_time'),
      overdue: sql<boolean>`(${w.delivery} is null and coalesce(${B.deliveryDate} < ${today}::date, false))`.as('overdue'),
      billDate: sql<string | null>`${B.billDate}::text`.as('bill_date'),
      plannedDelivery: sql<string | null>`${B.deliveryDate}::text`.as('planned_delivery'),
      completedAt: sql<Date | string | null>`${w.deliveredAt}`.as('completed_at'),
      deliveryOutcome: sql<string | null>`${w.delivery}`.as('delivery_outcome'),
      paymentStatus: sql<string | null>`${paymentStatus}`.as('payment_status'),
      outstandingAmount: sql<string | null>`${outstandingAmount}`.as('outstanding_amount'),
      bucket: sql<number>`(case
        when ${w.delivery} is not null then 9
        when ${B.deliveryDate} < ${today}::date then 1
        when ${B.deliveryDate} = ${today}::date then 3
        when ${underWay} or ${B.billDate} = ${today}::date then 4
        when ${B.deliveryDate} > ${today}::date then 5
        else 6 end)`.as('bucket'),
      upcoming: sql<boolean>`(${w.delivery} is null and coalesce(${B.deliveryDate} > ${today}::date, false))`.as('upcoming'),
      seq: sql<number>`${B.billNumber}`.as('seq'),
    })
    .from(B)
    .innerJoin(BK, eq(BK.id, B.bookId))
    .leftJoin(paid, eq(paid.billId, B.id))
    .leftJoin(w, eq(w.billId, B.id))
    .where(eq(B.tenantId, tenantId));

  const q = unionAll(appointmentRows, billRows).as('queue');
  const inView: Record<WorkView, SQL> = {
    TODAY: sql`${q.bucket} <= 4`,
    PENDING: sql`${q.bucket} < 9`,
    UPCOMING: sql`${q.upcoming}`,
    COMPLETED: sql`${q.bucket} = 9`,
  };
  const term = opts.search?.trim();
  const searchedAllPending = !!term && opts.view === 'TODAY';
  const view: WorkView = searchedAllPending ? 'PENDING' : opts.view;
  const digits = term ? normalizeMobile(term) : '';
  const matches = term
    ? or(ilike(q.customerName, `%${term}%`), ilike(q.reference, `%${term}%`), ilike(q.babyName, `%${term}%`), ...(digits.length >= 4 ? [sql`${q.mobileSearch} like ${`%${digits}%`}`] : []))
    : undefined;
  const where = and(inView[view], matches);
  const order =
    view === 'COMPLETED'
      ? [sql`${q.completedAt} desc nulls last`, desc(q.seq)]
      : view === 'UPCOMING'
        ? [asc(q.dueDate), sql`${q.dueTime} asc nulls last`, asc(q.kind), asc(q.seq)]
        : [asc(q.bucket), asc(q.dueDate), sql`${q.dueTime} asc nulls last`, asc(q.kind), asc(q.seq)];

  const [{ total }] = await db.select({ total: count() }).from(q).where(where);
  const rows = await db
    .select()
    .from(q)
    .where(where)
    .orderBy(...order)
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  // Every view's size in ONE aggregate, with no search — the chips' counts.
  const [c] = await db
    .select({
      TODAY: sql<number>`(count(*) filter (where ${inView.TODAY}))::int`,
      PENDING: sql<number>`(count(*) filter (where ${inView.PENDING}))::int`,
      UPCOMING: sql<number>`(count(*) filter (where ${inView.UPCOMING}))::int`,
      COMPLETED: sql<number>`(count(*) filter (where ${inView.COMPLETED}))::int`,
    })
    .from(q);
  // Money only for someone who may see money (Billing or Receipts read) — Studio Work alone is not enough.
  const advance = opts.money ? await availableAdvanceByCustomer(tenantId, rows.map((r) => r.mobileSearch)) : new Map<string, number>();

  return {
    today,
    view: opts.view,
    searchedAllPending,
    rows: rows.map(({ seq: _seq, bucket: _bucket, upcoming: _upcoming, completedAt, ...r }) => ({
      ...r,
      next: r.next as WorkQueue['rows'][number]['next'],
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
      deliveryOutcome: r.deliveryOutcome as WorkStageOutcome | null,
      paymentStatus: opts.money ? (r.paymentStatus as BillPaymentStatus | null) : null,
      outstandingAmount: !opts.money || r.outstandingAmount === null ? null : Number(r.outstandingAmount),
      availableAdvance: advance.get(r.mobileSearch) ?? 0,
      // Same rule as the bill's own payments panel (`getBillPayments`): min(available, due), in paise.
      advanceToApply: r.kind === 'BILL' ? fromPaise(Math.max(0, Math.min(toPaise(advance.get(r.mobileSearch) ?? 0), toPaise(Number(r.outstandingAmount ?? 0))))) : 0,
    })),
    total: Number(total),
    page: opts.page,
    pageSize: opts.limit,
    counts: { TODAY: Number(c.TODAY), PENDING: Number(c.PENDING), UPCOMING: Number(c.UPCOMING), COMPLETED: Number(c.COMPLETED) },
  };
}

/* ------------------------------------------------------- delivery report -- */

export interface DeliveryFilters {
  view: DeliveryView;
  search?: string;
  from?: string;
  to?: string;
}

/**
 * Reports -> Delivery. Pending = Delivery not recorded; Due today / Overdue compare the PROMISED
 * date (the bill's Delivery Date) with today's business date, so a bill with no promised date is
 * pending but never due or overdue. Payment columns are the receipts' derived position — delivery
 * and payment are independent.
 */
export async function deliveryReport(tenantId: string, f: DeliveryFilters, paging: { page: number; limit: number; full?: boolean }, money: boolean): Promise<DeliveryReport> {
  const today = await businessToday(tenantId);
  const paid = paidSubquery(tenantId);
  const { outstandingAmount, paymentStatus } = paymentColumns(paid);
  const w = workSubquery(tenantId);
  const position = workPositionSql(w);
  const pending = isNull(w.delivery);
  const inView = (v: DeliveryView): SQL | undefined =>
    ({
      PENDING: pending,
      DUE_TODAY: and(pending, eq(B.deliveryDate, today)),
      OVERDUE: and(pending, lt(B.deliveryDate, today)),
      DELIVERED: eq(w.delivery, 'DONE'),
      ALL: undefined,
    })[v];
  const scope = and(eq(B.tenantId, tenantId), f.from ? gte(B.billDate, f.from) : undefined, f.to ? lte(B.billDate, f.to) : undefined);
  const where = and(scope, inView(f.view), billSearch(f.search));
  const from = <T extends Record<string, unknown>>(fields: T) =>
    db
      .select(fields as never)
      .from(B)
      .innerJoin(BK, eq(BK.id, B.bookId))
      .leftJoin(paid, eq(paid.billId, B.id))
      .leftJoin(w, eq(w.billId, B.id));

  const [{ total }] = (await from({ total: count() }).where(where)) as { total: number }[];
  if (paging.full && Number(total) > WORK_EXPORT_MAX_ROWS) {
    throw new AppError('REPORT_TOO_LARGE', `This report has ${total} rows; export and print carry at most ${WORK_EXPORT_MAX_ROWS}. Narrow the filters and try again.`, 422);
  }
  const order =
    f.view === 'DELIVERED'
      ? [desc(w.deliveredOn), desc(B.billDate), desc(B.billNumber)]
      : f.view === 'ALL'
        ? [desc(B.billDate), desc(B.billNumber)]
        : [sql`${B.deliveryDate} asc nulls last`, asc(B.billDate), asc(B.billNumber)];
  const rows = (await from({
    id: B.id,
    bookNumber: BK.bookNumber,
    billNumber: B.billNumber,
    billDate: B.billDate,
    customerName: B.customerName,
    mobileNumber: B.mobileNumber,
    mobileSearch: B.mobileSearch,
    babyName: B.babyName,
    plannedDelivery: B.deliveryDate,
    position,
    deliveredOn: w.deliveredOn,
    deliveryOutcome: w.delivery,
    grandTotal: B.grandTotal,
    paymentStatus,
    outstandingAmount,
  })
    .where(where)
    .orderBy(...order)
    .limit(paging.full ? WORK_EXPORT_MAX_ROWS : paging.limit)
    .offset(paging.full ? 0 : (paging.page - 1) * paging.limit)) as Record<string, unknown>[];

  // Every view's size in ONE aggregate — same scope, no view narrowing, no search.
  const [c] = (await from(
    Object.fromEntries(DELIVERY_VIEWS.map((v) => [v, sql<number>`(count(*) filter (where ${inView(v) ?? sql`true`}))::int`])),
  ).where(scope)) as Record<DeliveryView, number>[];
  const counts = Object.fromEntries(DELIVERY_VIEWS.map((v) => [v, Number(c[v])])) as Record<DeliveryView, number>;

  return {
    today,
    rows: rows.map((r) => ({
      ...(r as unknown as DeliveryReport['rows'][number]),
      // Studio Work alone is not enough to see money — the same rule as Today's Work.
      grandTotal: money ? Number(r.grandTotal) : null,
      paymentStatus: money ? (r.paymentStatus as DeliveryReport['rows'][number]['paymentStatus']) : null,
      outstandingAmount: money ? Number(r.outstandingAmount) : null,
    })),
    total: Number(total),
    page: paging.full ? 1 : paging.page,
    pageSize: paging.full ? rows.length : paging.limit,
    counts,
  };
}
