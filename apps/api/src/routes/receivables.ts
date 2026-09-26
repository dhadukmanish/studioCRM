import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  BILL_PAYMENT_STATUS_LABELS,
  RECEIVABLES_EXPORTS,
  receivableBillsQuerySchema,
  receivableCustomersQuerySchema,
  receivablesScopeSchema,
} from '@erp/shared';
import { z } from 'zod';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { csvInteger, csvNumber, toCsv } from '../lib/csv';
import {
  businessToday,
  receivableBills,
  receivableCustomerDetail,
  receivableCustomers,
  receivablesOverview,
  type Paging,
  type ReceivablesScope,
} from '../services/receivables';

/**
 * Receivables / Outstanding reports (docs/RECEIVABLES_REPORTS.md) — read-only.
 *
 * `reports_receivables` read covers viewing, printing and CSV export. Nothing here writes; acting
 * on a row (Receive payment, opening a bill or a receipt) goes to that module's own routes and
 * needs that module's own permission.
 *
 * Every endpoint takes the same scope (`asOf`, `from`/`to` on the bill date, `bookId`), so the KPI
 * strip, Summary, Outstanding Bills and Aging always describe the same bills.
 */
const PERMISSION = 'reports_receivables';
const BASE = '/api/reports/receivables';

async function scopeOf(req: FastifyRequest): Promise<ReceivablesScope> {
  const s = parse(receivablesScopeSchema, req.query ?? {});
  return { tenantId: req.user.tenantId, asOf: s.asOf ?? (await businessToday(req.user.tenantId)), from: s.from, to: s.to, bookId: s.bookId };
}

function pagingOf(req: FastifyRequest, full: boolean): Paging {
  const q = parseListQuery(req.query as Record<string, unknown>);
  return { page: q.page, limit: q.limit, sortBy: q.sortBy, sortOrder: q.sortOrder, full };
}

const exportQuerySchema = z.object({ report: z.enum(RECEIVABLES_EXPORTS) });

export async function receivableRoutes(app: FastifyInstance) {
  /** KPI strip: every bill in scope, paid ones included. Also tells the client the As-of date used. */
  app.get(`${BASE}/overview`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => ok(await receivablesOverview(await scopeOf(req))));

  /** Customer summary (and customer-wise Aging). `full=1` returns every row, for print. */
  app.get(`${BASE}/customers`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const scope = await scopeOf(req);
    const f = parse(receivableCustomersQuerySchema, req.query ?? {});
    const paging = pagingOf(req, f.full);
    const res = await receivableCustomers(scope, { search: f.search, all: f.all }, paging);
    return ok({ asOf: scope.asOf, ...res, page: paging.page, pageSize: paging.limit });
  });

  /** One customer: header, their bills in scope, and the receipts that settled them. */
  app.get(`${BASE}/customers/:key`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { key } = req.params as { key: string };
    return ok(await receivableCustomerDetail(await scopeOf(req), key));
  });

  /** Bill-wise outstanding. Default: Unpaid + Partially paid, oldest first. `full=1` for print. */
  app.get(`${BASE}/bills`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const scope = await scopeOf(req);
    const f = parse(receivableBillsQuerySchema, req.query ?? {});
    const paging = pagingOf(req, f.full);
    const res = await receivableBills(scope, { status: f.status, bucket: f.bucket, search: f.search, customer: f.customer }, paging);
    return ok({ asOf: scope.asOf, ...res, page: paging.page, pageSize: paging.limit });
  });

  /**
   * CSV of the WHOLE filtered result — the same query, filters and sort as the screen, never just
   * the page on it. Dates are ISO "YYYY-MM-DD" (unambiguous in every spreadsheet locale), money is
   * plain 2-decimal numbers, and user text is guarded against formula injection (`lib/csv.ts`).
   */
  app.get(`${BASE}/export`, { preHandler: app.requirePermission(PERMISSION) }, async (req, reply) => {
    const { report } = parse(exportQuerySchema, req.query ?? {});
    const scope = await scopeOf(req);
    const paging = pagingOf(req, true);
    let csv: string;
    if (report === 'bills') {
      const f = parse(receivableBillsQuerySchema, req.query ?? {});
      const { rows } = await receivableBills(scope, { status: f.status, bucket: f.bucket, search: f.search, customer: f.customer }, paging);
      csv = toCsv(
        ['Book', 'Bill No', 'Bill Date', 'Customer', 'Mobile', 'Grand Total', 'Paid', 'Outstanding', 'Payment Status', 'Age (days from bill date)', 'Aging Bucket'],
        rows.map((r) => [
          r.bookNumber,
          csvInteger(r.billNumber),
          r.billDate,
          r.customerName,
          r.mobileNumber,
          csvNumber(r.grandTotal),
          csvNumber(r.paidAmount),
          csvNumber(r.outstandingAmount),
          BILL_PAYMENT_STATUS_LABELS[r.paymentStatus],
          csvInteger(r.ageDays),
          AGING_BUCKET_LABELS[r.agingBucket],
        ]),
      );
    } else {
      const f = parse(receivableCustomersQuerySchema, req.query ?? {});
      const { rows } = await receivableCustomers(scope, { search: f.search, all: f.all }, paging);
      csv =
        report === 'customers'
          ? toCsv(
              ['Customer', 'Mobile', 'Bills', 'Pending Bills', 'Total Billed', 'Paid', 'Outstanding', 'Oldest Pending Bill Date', 'Oldest Pending Age (days)'],
              rows.map((r) => [
                r.customerName,
                r.mobileNumber,
                csvInteger(r.billCount),
                csvInteger(r.pendingBills),
                csvNumber(r.totalBilled),
                csvNumber(r.totalPaid),
                csvNumber(r.totalOutstanding),
                r.oldestPendingDate,
                r.oldestPendingAge === null ? null : csvInteger(r.oldestPendingAge),
              ]),
            )
          : toCsv(
              ['Customer', 'Mobile', ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABELS[b]), 'Total Outstanding', 'Oldest Pending Bill Date'],
              rows.map((r) => [r.customerName, r.mobileNumber, ...AGING_BUCKETS.map((b) => csvNumber(r.aging[b])), csvNumber(r.totalOutstanding), r.oldestPendingDate]),
            );
    }
    const name = { customers: 'Receivables-Summary', bills: 'Outstanding-Bills', aging: 'Receivables-Aging' }[report];
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}-as-of-${scope.asOf}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}
