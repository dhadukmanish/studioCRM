import type { FastifyInstance, FastifyRequest } from 'fastify';
import { dashboardQuerySchema, hasPermission } from '@erp/shared';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { dashboardSummary } from '../services/dashboard';

/**
 * The Dashboard (docs/DASHBOARD.md). Every signed-in user may open it; each SECTION is decided here,
 * on the server, by the permission of the module it summarises — a section the user may not see is
 * neither queried nor returned:
 *   inquiries — Appointments (read)
 *   orders    — Billing or Studio Work (read)
 *   money     — Billing, Receipts or Receivables Reports (read)
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', { preHandler: app.authenticate }, async (req: FastifyRequest) => {
    const q = parse(dashboardQuerySchema, req.query ?? {});
    const can = (key: string) => req.user.isSuperAdmin || hasPermission(req.user.grants, key, 'read');
    return ok(
      await dashboardSummary(req.user.tenantId, q, {
        inquiries: can('operations_appointments'),
        orders: can('operations_billing') || can('operations_work'),
        money: can('operations_billing') || can('operations_receipts') || can('reports_receivables'),
      }),
    );
  });
}
