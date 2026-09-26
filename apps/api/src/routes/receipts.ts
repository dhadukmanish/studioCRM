import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { PAYMENT_MODES, receiptCancelSchema, receiptSchema, type PaymentMode } from '@erp/shared';
import { schema } from '../db/client';
import { parse } from '../lib/validate';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, type ColumnMap } from '../lib/filters';
import { logActivity } from '../services/activity';
import {
  cancelReceipt,
  countReceipts,
  createReceipt,
  getReceipt,
  listPaymentAccounts,
  listPendingBills,
  listReceivableCustomers,
  receiptColumns,
  receiptSearch,
  receiptsFrom,
  shapeReceipt,
} from '../services/receipts';

/**
 * Receipts — money received against saved bills (docs/RECEIPTS_PAYMENTS.md). Business rules live
 * in `services/receipts.ts`; this file validates, authorizes and audits.
 *
 * Permissions (`operations_receipts`): read to see receipts and the lookups the form needs,
 * create to record one, update to CANCEL one. There is no edit and no delete — a receipt is
 * financial history.
 */
const PERMISSION = 'operations_receipts';
const BASE = '/api/receipts';
const LABEL = 'Receipt';

const R = schema.receipts;

export async function receiptRoutes(app: FastifyInstance) {
  /** List: newest receipt date first, the receipt number as the stable tie-breaker. */
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const cols = receiptColumns as unknown as ColumnMap;
    const where = and(eq(R.tenantId, req.user.tenantId), receiptSearch(q.search), filterWhere((req.query as Record<string, unknown>).filters, cols));
    const total = await countReceipts(where);
    const order = q.sortBy && cols[q.sortBy] ? [sortBy(q.sortBy, q.sortOrder, cols, R.receiptDate), desc(R.receiptNumber)] : [desc(R.receiptDate), desc(R.receiptNumber)];
    const rows = await receiptsFrom()
      .where(where)
      .orderBy(...order)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    return ok({ rows: rows.map(shapeReceipt), total, page: q.page, pageSize: q.limit }, `${LABEL}s retrieved successfully`);
  });

  /** Customers with money due (or one exact customer by `key`) — the form's customer picker. */
  app.get(`${BASE}/customers`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { search, key } = req.query as { search?: string; key?: string };
    return ok(await listReceivableCustomers(req.user.tenantId, { search: typeof search === 'string' ? search : undefined, key: typeof key === 'string' ? key : undefined }));
  });

  /** One customer's bills with something outstanding, oldest first. */
  app.get(`${BASE}/pending-bills`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { customer } = req.query as { customer?: string };
    return ok(typeof customer === 'string' ? await listPendingBills(req.user.tenantId, customer) : []);
  });

  /** Accounts that may receive money for a mode. The create re-validates whichever one is sent. */
  app.get(`${BASE}/accounts`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { mode } = req.query as { mode?: string };
    if (!(PAYMENT_MODES as readonly unknown[]).includes(mode)) throw validation('Choose Cash or Bank');
    return ok(await listPaymentAccounts(req.user.tenantId, mode as PaymentMode));
  });

  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    return ok(await getReceipt(req.user.tenantId, id));
  });

  /** Create — the whole receipt, allocations and number in one transaction. */
  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(receiptSchema, req.body);
    const id = await createReceipt(req.user.tenantId, req.user.id, body);
    const created = await getReceipt(req.user.tenantId, id);
    // Receipt, amount and what it settled — no mobile, no account number.
    await logActivity(req, 'receipt', id, 'receipt_created', `${LABEL} No. ${created.receiptNumber} for ₹${created.amount.toFixed(2)} created`, {
      receiptNumber: created.receiptNumber,
      amount: created.amount,
      paymentMode: created.paymentMode,
      bills: created.allocations.map((a) => ({ billId: a.billId, bill: `${a.bookNumber}/${a.billNumber}`, amount: a.amount })),
    });
    return ok(created, `${LABEL} No. ${created.receiptNumber} saved`);
  });

  /** Cancel — never delete. The receipt and its allocations stay, marked CANCELLED. */
  app.post(`${BASE}/:id/cancel`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(receiptCancelSchema, req.body ?? {});
    const cancelled = await cancelReceipt(req.user.tenantId, req.user.id, id, reason);
    await logActivity(req, 'receipt', id, 'receipt_cancelled', `${LABEL} No. ${cancelled.receiptNumber} for ₹${cancelled.amount.toFixed(2)} cancelled`, {
      receiptNumber: cancelled.receiptNumber,
      amount: cancelled.amount,
      reason,
    });
    return ok(await getReceipt(req.user.tenantId, id), `${LABEL} No. ${cancelled.receiptNumber} cancelled`);
  });
}
