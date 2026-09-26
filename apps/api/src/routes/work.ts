import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BILL_PAYMENT_STATUS_LABELS,
  WORK_POSITION_LABELS,
  WORK_STAGES,
  WORK_STAGE_LABELS,
  deliveryReportQuerySchema,
  hasPermission,
  workQueueQuerySchema,
  workStageRecordSchema,
} from '@erp/shared';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { csvInteger, csvNumber, toCsv } from '../lib/csv';
import { logActivity } from '../services/activity';
import { deliveryReport, getBillWork, recordStage, reopenStage, workQueue } from '../services/work';

/**
 * The studio workflow (docs/STUDIO_WORKFLOW.md) — the Work Queue, a job's progress, the one-click
 * stage actions and Reports -> Delivery. Rules live in `services/work.ts`.
 *
 * `operations_work`: read to see the queue, a bill's progress and the Delivery report (print and
 * CSV included); update to complete, skip or reopen a stage. Seeing is never doing.
 */
const PERMISSION = 'operations_work';

/** Money (Due, Paid, Advance, Grand Total, Outstanding) is shown only to someone who may see Billing or Receipts. */
const seesMoney = (req: FastifyRequest) => req.user.isSuperAdmin || hasPermission(req.user.grants, 'operations_billing', 'read') || hasPermission(req.user.grants, 'operations_receipts', 'read');

const stageParams = z.object({ id: z.string().uuid('Unknown bill'), stage: z.enum(WORK_STAGES, { errorMap: () => ({ message: 'Unknown workflow stage' }) }) });
const billParams = z.object({ id: z.string().uuid('Unknown bill') });

export async function workRoutes(app: FastifyInstance) {
  /** Today's Work. Appointments join it only for someone who may see appointments; Due / Advance only for someone who may see money. */
  app.get('/api/work/queue', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const f = parse(workQueueQuerySchema, req.query ?? {});
    const { page, limit } = parseListQuery(req.query as Record<string, unknown>);
    const appointments = req.user.isSuperAdmin || hasPermission(req.user.grants, 'operations_appointments', 'read');
    const money = seesMoney(req);
    return ok(await workQueue(req.user.tenantId, { view: f.view, search: f.search, page, limit, appointments, money }));
  });

  app.get('/api/work/bills/:id', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = parse(billParams, req.params);
    return ok(await getBillWork(req.user.tenantId, id));
  });

  /** One click: record the stage (DONE, or SKIPPED). Repeating it changes nothing. */
  app.post('/api/work/bills/:id/stages/:stage', { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id, stage } = parse(stageParams, req.params);
    const { outcome } = parse(workStageRecordSchema, req.body ?? {});
    const r = await recordStage(req.user.tenantId, req.user.id, id, stage, outcome);
    const what = outcome === 'SKIPPED' ? 'skipped' : stage === 'DELIVERY' ? 'delivered' : 'completed';
    if (r.changed) await logActivity(req, 'bill', id, outcome === 'SKIPPED' ? 'work_stage_skipped' : 'work_stage_done', `Bill ${r.billLabel} — ${WORK_STAGE_LABELS[stage]} ${what}`, { stage, outcome });
    return ok(await getBillWork(req.user.tenantId, id), r.changed ? `${WORK_STAGE_LABELS[stage]} ${what}` : `${WORK_STAGE_LABELS[stage]} was already recorded`);
  });

  /** Reopen: the stage is pending again. For correcting a mistaken click. */
  app.delete('/api/work/bills/:id/stages/:stage', { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id, stage } = parse(stageParams, req.params);
    const r = await reopenStage(req.user.tenantId, id, stage);
    await logActivity(req, 'bill', id, 'work_stage_reopened', `Bill ${r.billLabel} — ${WORK_STAGE_LABELS[stage]} reopened`, { stage });
    return ok(await getBillWork(req.user.tenantId, id), `${WORK_STAGE_LABELS[stage]} reopened`);
  });

  /* ------------------------------------------------------ Reports -> Delivery -- */

  app.get('/api/reports/delivery', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const f = parse(deliveryReportQuerySchema, req.query ?? {});
    const { page, limit } = parseListQuery(req.query as Record<string, unknown>);
    return ok(await deliveryReport(req.user.tenantId, f, { page, limit, full: f.full }, seesMoney(req)));
  });

  /** CSV of the WHOLE filtered result, through the formula-safe `toCsv`. Dates are ISO. */
  app.get('/api/reports/delivery/export', { preHandler: app.requirePermission(PERMISSION) }, async (req, reply) => {
    const f = parse(deliveryReportQuerySchema, req.query ?? {});
    const money = seesMoney(req);
    const { rows, today } = await deliveryReport(req.user.tenantId, f, { page: 1, limit: 1, full: true }, money);
    const csv = toCsv(
      ['Book', 'Bill No', 'Bill Date', 'Customer', 'Mobile', 'Baby', 'Planned Delivery', 'Current Stage', 'Delivered On', ...(money ? ['Grand Total', 'Payment Status', 'Outstanding'] : [])],
      rows.map((r) => [
        r.bookNumber,
        csvInteger(r.billNumber),
        r.billDate,
        r.customerName,
        r.mobileNumber,
        r.babyName,
        r.plannedDelivery,
        r.deliveryOutcome === 'SKIPPED' ? 'Delivery not needed' : WORK_POSITION_LABELS[r.position],
        r.deliveredOn,
        ...(money ? [csvNumber(r.grandTotal ?? 0), r.paymentStatus && BILL_PAYMENT_STATUS_LABELS[r.paymentStatus], csvNumber(r.outstandingAmount ?? 0)] : []),
      ]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="Delivery-${f.view.toLowerCase()}-${today}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}
