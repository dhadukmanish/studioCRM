import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/respond';
import { notFound, validation } from '../lib/errors';
import { shareOpenedSchema } from '@erp/shared';
import { getBillInvoice, getBillInvoicePdf, getBillInvoiceShare, resolveShareTemplate } from '../services/invoice';
import { logActivity } from '../services/activity';
import { parse } from '../lib/validate';
import { isUuid } from '../services/invoiceTemplates';
import { unprintableText } from '../services/invoicePdf';

/**
 * A saved bill's invoice. Whoever may read the bill may preview and download its invoice —
 * `operations_billing` read — so a billing operator needs no Settings permission to print.
 * Read-only: nothing here writes a bill, a line or a counter.
 *
 *   GET /api/bills/:id/invoice?templateId=        the render model (the preview draws it), plus
 *                                                 `pdfUnprintable`: characters the PDF cannot draw
 *   GET /api/bills/:id/invoice/pdf?templateId=    the PDF (`?download=1` for an attachment)
 *   GET /api/bills/:id/invoice/share              WhatsApp share context (saved mobile, message)
 *   POST /api/bills/:id/invoice/share-opened      audit: WhatsApp was opened (never "sent")
 *
 * All resolve the bill and the template inside the caller's tenant; a bill or template of
 * another tenant is "not found".
 */
const PERMISSION = 'operations_billing';

function params(req: { params: unknown; query: unknown }) {
  const { id } = req.params as { id: string };
  if (!isUuid(id)) throw notFound('Bill');
  const { templateId } = (req.query ?? {}) as { templateId?: string };
  if (templateId !== undefined && templateId !== '' && !isUuid(templateId)) throw validation('Unknown invoice template');
  return { id, templateId: templateId || undefined };
}

export async function invoiceRoutes(app: FastifyInstance) {
  app.get('/api/bills/:id/invoice', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id, templateId } = params(req);
    const { model } = await getBillInvoice(req.user.tenantId, id, templateId);
    // Characters the PDF fonts cannot draw: the preview warns, and the PDF download refuses them (docs/INVOICE_TEMPLATES.md).
    return ok({ ...model, pdfUnprintable: [...new Set(unprintableText(model).flatMap((p) => p.characters))] });
  });

  /**
   * WhatsApp sharing (docs/WHATSAPP_SHARING.md). The same read permission as preview/PDF — sharing
   * is showing the invoice to its customer. Nothing here writes a bill, a line or a counter.
   */
  app.get('/api/bills/:id/invoice/share', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = params(req);
    return ok(await getBillInvoiceShare(req.user.tenantId, id));
  });

  /**
   * The operator opened WhatsApp for this invoice. Records exactly that — "share opened", never
   * "sent": click-to-chat cannot know whether a message was sent or delivered. The audit entry keeps
   * the template and transport only; no number and no message text (customer PII).
   */
  app.post('/api/bills/:id/invoice/share-opened', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = params(req);
    const body = parse(shareOpenedSchema, req.body ?? {});
    if (body.templateId && !isUuid(body.templateId)) throw validation('Unknown invoice template');
    const t = await resolveShareTemplate(req.user.tenantId, id, body.templateId || undefined);
    await logActivity(req, 'bill', id, 'whatsapp_share_opened', `Invoice ${t.documentLabel} — WhatsApp opened to share it`, { transport: body.transport, templateId: t.templateId, templateName: t.templateName });
    return ok({ recorded: true });
  });

  app.get('/api/bills/:id/invoice/pdf', { preHandler: app.requirePermission(PERMISSION) }, async (req, reply) => {
    const { id, templateId } = params(req);
    const { bytes, fileName } = await getBillInvoicePdf(req.user.tenantId, id, templateId);
    const download = (req.query as { download?: string }).download === '1';
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(bytes));
  });
}
