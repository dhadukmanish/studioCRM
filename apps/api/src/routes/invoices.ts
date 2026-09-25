import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/respond';
import { notFound, validation } from '../lib/errors';
import { publicLinkCreateSchema, shareOpenedSchema } from '@erp/shared';
import { getBillInvoice, getBillInvoicePdf, getBillInvoiceShare, resolveShareTemplate } from '../services/invoice';
import { logActivity } from '../services/activity';
import { parse } from '../lib/validate';
import { isUuid } from '../services/invoiceTemplates';
import { unprintableText } from '../services/invoicePdf';
import { auditRevokedLinks, billDocumentLabel, getPublicLinkState, preparePublicLink, revokePublicLink } from '../services/publicInvoiceLinks';

/**
 * A saved bill's invoice. Whoever may read the bill may preview and download its invoice —
 * `operations_billing` read — so a billing operator needs no Settings permission to print.
 * Nothing here writes a bill, a line or a counter; the only writes are public-link rows and audit.
 *
 *   GET /api/bills/:id/invoice?templateId=        the render model (the preview draws it), plus
 *                                                 `pdfUnprintable`: characters the PDF cannot draw
 *   GET /api/bills/:id/invoice/pdf?templateId=    the PDF (`?download=1` for an attachment)
 *   GET /api/bills/:id/invoice/share              WhatsApp share context (saved mobile, message)
 *   GET|POST|DELETE …/invoice/public-link         the customer's public invoice link (Phase 5.1)
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

  /**
   * The bill's public invoice link (Phase 5.1, docs/WHATSAPP_SHARING.md) — what the customer opens
   * from WhatsApp without logging in. Whoever may send the invoice to its customer (Billing read) may
   * make and reuse that link; withdrawing it by hand needs Billing update. At most one is active.
   *
   *   GET     state only — never creates a link (opening the Share dialog must not publish anything)
   *   POST    prepare: reuse the live link for this template and bill revision, else replace it
   *   DELETE  revoke (Billing update): the URL stops working at once; nothing new is made
   */
  app.get('/api/bills/:id/invoice/public-link', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = params(req);
    return ok(await getPublicLinkState(req.user.tenantId, id));
  });

  app.post('/api/bills/:id/invoice/public-link', { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = params(req);
    const body = parse(publicLinkCreateSchema, req.body ?? {});
    if (body.templateId && !isUuid(body.templateId)) throw validation('Unknown invoice template');
    const { link, linkId, revoked } = await preparePublicLink(req.user.tenantId, id, body.templateId || undefined);
    if (link.outcome === 'CREATED') {
      const label = await billDocumentLabel(req.user.tenantId, id);
      for (const r of revoked) await auditRevokedLinks(req, id, label, [r.id], r.reason);
      await logActivity(req, 'bill', id, 'invoice_public_link_created', `Invoice ${label} — public link created`, { linkId, templateId: link.templateId, templateName: link.templateName });
    }
    return ok(link);
  });

  // Manual revoke invalidates a URL that may already be with the customer — a state change, so it
  // needs Billing UPDATE. (Automatic revokes ride on the bill update / template management itself.)
  app.delete('/api/bills/:id/invoice/public-link', { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = params(req);
    const revoked = await revokePublicLink(req.user.tenantId, id);
    if (revoked.length) await auditRevokedLinks(req, id, await billDocumentLabel(req.user.tenantId, id), revoked, 'MANUAL');
    return ok({ revoked: revoked.length > 0 }, revoked.length ? 'Invoice link revoked' : 'There was no active invoice link');
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
