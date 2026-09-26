import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BILL_PAYMENT_STATUS_LABELS, INVOICE_TAX_MODE_LABELS, billReportExportQuerySchema, billReportQuerySchema } from '@erp/shared';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { csvInteger, csvNumber, toCsv } from '../lib/csv';
import { billDetail, billReportCustomers, billReportScope, billSummary } from '../services/billReport';
import type { Paging } from '../services/receivables';

/**
 * Reports -> Bill Summary (docs/BILL_SUMMARY_REPORT.md) — read-only.
 *
 * `reports_bills` read covers viewing, preview, print and CSV. Nothing here writes; opening a bill
 * from a row needs Billing's own permission. Both tabs take the same scope query, so Summary and
 * Detailed always describe the same bills.
 */
const PERMISSION = 'reports_bills';
const BASE = '/api/reports/bills';

async function requestOf(req: FastifyRequest, full?: boolean) {
  const q = parse(billReportQuerySchema, req.query ?? {});
  const l = parseListQuery(req.query as Record<string, unknown>);
  const paging: Paging = { page: l.page, limit: l.limit, sortBy: l.sortBy, sortOrder: l.sortOrder, full: full ?? q.full };
  return { scope: await billReportScope(req.user.tenantId, q), paging };
}

const customersQuerySchema = z.object({ search: z.string().trim().max(100).optional(), key: z.string().trim().max(40).optional() });

export async function billReportRoutes(app: FastifyInstance) {
  app.get(`${BASE}/summary`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { scope, paging } = await requestOf(req);
    return ok({ ...(await billSummary(scope, paging)), page: paging.page, pageSize: paging.limit });
  });

  app.get(`${BASE}/detailed`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { scope, paging } = await requestOf(req);
    return ok({ ...(await billDetail(scope, paging)), page: paging.page, pageSize: paging.limit });
  });

  app.get(`${BASE}/customers`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const f = parse(customersQuerySchema, req.query ?? {});
    return ok(await billReportCustomers(req.user.tenantId, { search: f.search || undefined, key: f.key || undefined }));
  });

  /**
   * CSV of the WHOLE filtered result, same scope and sort as the screen. Dates are ISO, money plain
   * 2-decimal numbers, user text formula-guarded (`lib/csv.ts`). Detailed carries each bill's
   * Advance / Received on its first line only, so every money column adds up to the Summary's.
   */
  app.get(`${BASE}/export`, { preHandler: app.requirePermission(PERMISSION) }, async (req, reply) => {
    const { tab } = parse(billReportExportQuerySchema, req.query ?? {});
    const { scope, paging } = await requestOf(req, true);
    let csv: string;
    if (tab === 'summary') {
      const { rows } = await billSummary(scope, paging);
      csv = toCsv(
        ['Book', 'Bill No', 'Bill Date', 'Customer', 'Mobile', 'Baby Name', 'Planned Delivery', 'Series', 'Sub Total', 'Discount', 'GST', 'Grand Total', 'Advance / Received', 'Payment Status'],
        rows.map((r) => [
          r.bookNumber,
          csvInteger(r.billNumber),
          r.billDate,
          r.customerName,
          r.mobileNumber,
          r.babyName,
          r.plannedDelivery,
          INVOICE_TAX_MODE_LABELS[r.seriesType],
          csvNumber(r.subTotal),
          csvNumber(r.discount),
          csvNumber(r.gst),
          csvNumber(r.grandTotal),
          csvNumber(r.advance),
          BILL_PAYMENT_STATUS_LABELS[r.paymentStatus],
        ]),
      );
    } else {
      const { rows } = await billDetail(scope, paging);
      csv = toCsv(
        ['Book', 'Bill No', 'Bill Date', 'Customer', 'Mobile', 'Baby Name', 'Line', 'Item', 'Product', 'Qty', 'Rate', 'Amount', 'Discount', 'Taxable', 'GST %', 'GST', 'Line Total', 'Advance / Received (bill, on its first line)'],
        rows.map((r) => [
          r.bookNumber,
          csvInteger(r.billNumber),
          r.billDate,
          r.customerName,
          r.mobileNumber,
          r.babyName,
          csvInteger(r.lineNumber),
          r.itemName,
          r.productName,
          csvNumber(r.quantity),
          csvNumber(r.rate),
          csvNumber(r.amount),
          csvNumber(r.discount),
          csvNumber(r.taxable),
          csvNumber(r.gstRate),
          csvNumber(r.gst),
          csvNumber(r.lineTotal),
          r.advance === null ? null : csvNumber(r.advance),
        ]),
      );
    }
    const range = [scope.from, scope.to].filter(Boolean).join('-to-') || 'all';
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="Bill-${tab === 'summary' ? 'Summary' : 'Detailed'}-${range}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}
