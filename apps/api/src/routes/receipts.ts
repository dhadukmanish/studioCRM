import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { PAYMENT_MODES, applyAdvanceSchema, receiptCancelSchema, receiptSchema, reverseApplicationSchema, type PaymentMode } from '@erp/shared';
import { schema } from '../db/client';
import { parse } from '../lib/validate';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, type ColumnMap } from '../lib/filters';
import { logActivity } from '../services/activity';
import {
  applyAdvance,
  cancelReceipt,
  countReceipts,
  createReceipt,
  customerAdvance,
  reverseApplication,
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

  /** A customer's advance still available, oldest receipt first. */
  app.get(`${BASE}/advance`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { customer } = req.query as { customer?: string };
    return ok(await customerAdvance(req.user.tenantId, typeof customer === 'string' ? customer : ''));
  });

  /**
   * Apply advance to a bill — money movement, so receipts CREATE. The amount is explicit; the
   * server spends the customer's oldest advance first, under lock (`applyAdvance`).
   */
  app.post(`${BASE}/apply-advance`, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(applyAdvanceSchema, req.body);
    const r = await applyAdvance(req.user.tenantId, req.user.id, body.billId, body.amount);
    await logActivity(req, 'bill', body.billId, 'advance_applied', `Advance ₹${r.amount.toFixed(2)} applied to Bill ${r.billLabel}`, {
      amount: r.amount,
      receipts: r.used.map((u) => ({ receiptId: u.receiptId, receiptNumber: u.receiptNumber, amount: u.amount })),
    });
    return ok(r, `Advance ₹${r.amount.toFixed(2)} applied to Bill ${r.billLabel}`);
  });

  /** Reverse an applied advance — receipts UPDATE, like cancelling. The row stays, marked REVERSED. */
  app.post(`${BASE}/applications/:id/reverse`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(reverseApplicationSchema, req.body ?? {});
    const r = await reverseApplication(req.user.tenantId, req.user.id, id, reason);
    await logActivity(req, 'bill', r.billId, 'advance_reversed', `Advance ₹${r.amount.toFixed(2)} from Receipt No. ${r.receiptNumber} reversed on Bill ${r.billLabel}`, { applicationId: id, receiptId: r.receiptId, amount: r.amount, reason });
    return ok(r, `Advance ₹${r.amount.toFixed(2)} reversed — it is available again`);
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
    // Receipt, amount, what it settled and what it kept as advance — no mobile, no account number.
    await logActivity(req, 'receipt', id, created.availableAmount > 0 ? 'advance_received' : 'receipt_created', `${LABEL} No. ${created.receiptNumber} for ₹${created.amount.toFixed(2)} created${created.availableAmount > 0 ? ` (advance ₹${created.availableAmount.toFixed(2)})` : ''}`, {
      receiptNumber: created.receiptNumber,
      amount: created.amount,
      advance: created.availableAmount,
      paymentMode: created.paymentMode,
      bills: created.allocations.map((a) => ({ billId: a.billId, bill: `${a.bookNumber}/${a.billNumber}`, amount: a.amount })),
    });
    return ok(created, `${LABEL} No. ${created.receiptNumber} saved${created.availableAmount > 0 ? ` — ₹${created.availableAmount.toFixed(2)} kept as advance` : ''}`);
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
