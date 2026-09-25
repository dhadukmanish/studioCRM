import type { FastifyInstance } from 'fastify';
import { invoiceTemplateSchema } from '@erp/shared';
import { parse } from '../lib/validate';
import { ok } from '../lib/respond';
import { logActivity } from '../services/activity';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  setDefaultTemplate,
  templateLookup,
  updateTemplate,
} from '../services/invoiceTemplates';

/**
 * Invoice Template Master (Settings). Managing templates needs `settings_invoice_templates`;
 * previewing a bill's invoice does not (see routes/invoices.ts). Rules live in the service.
 */
const PERMISSION = 'settings_invoice_templates';
const BASE = '/api/settings/invoice-templates';
const ENTITY = 'invoice_template';

export async function invoiceTemplateRoutes(app: FastifyInstance) {
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const rows = await listTemplates(req.user.tenantId);
    return ok({ rows, total: rows.length, page: 1, pageSize: rows.length }, 'Invoice templates retrieved successfully');
  });

  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => ok(await getTemplate(req.user.tenantId, (req.params as { id: string }).id)));

  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const t = await createTemplate(req.user.tenantId, parse(invoiceTemplateSchema, req.body));
    await logActivity(req, ENTITY, t.id, 'created', `Invoice template "${t.templateName}" created`);
    return ok(t, 'Invoice template created');
  });

  app.put(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { template: t } = await updateTemplate(req.user.tenantId, (req.params as { id: string }).id, parse(invoiceTemplateSchema, req.body));
    await logActivity(req, ENTITY, t.id, 'updated', `Invoice template "${t.templateName}" updated`);
    return ok(t, 'Invoice template updated');
  });

  app.post(`${BASE}/:id/default`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const t = await setDefaultTemplate(req.user.tenantId, (req.params as { id: string }).id);
    await logActivity(req, ENTITY, t.id, 'updated', `Invoice template "${t.templateName}" set as default`);
    return ok(t, `"${t.templateName}" is now the default template`);
  });

  app.post(`${BASE}/:id/duplicate`, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const { source, template: t } = await duplicateTemplate(req.user.tenantId, (req.params as { id: string }).id);
    await logActivity(req, ENTITY, t.id, 'created', `Invoice template "${t.templateName}" created as a copy of "${source.templateName}"`);
    return ok(t, `Created "${t.templateName}"`);
  });

  app.delete(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'delete') }, async (req) => {
    const t = await deleteTemplate(req.user.tenantId, (req.params as { id: string }).id);
    await logActivity(req, ENTITY, t.id, 'deleted', `Invoice template "${t.templateName}" deleted`);
    return ok(null, 'Invoice template deleted');
  });

  /** The invoice preview's template picker: active templates, picker fields only. */
  app.get('/api/common/lookups/invoice-templates', { preHandler: app.authenticate }, async (req) => ok(await templateLookup(req.user.tenantId)));
}
