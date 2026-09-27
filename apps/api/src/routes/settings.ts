import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, PRINT_ASSET_KINDS, PRINT_ASSET_LABELS, printSettingsSchema, type PrintAssetKind } from '@erp/shared';
import { getSettings, updateSettings } from '../services/settings';
import { deletePrintAsset, getCompanyProfile, getPrintAsset, LOGO_MAX_BYTES, savePrintAsset } from '../services/company';
import { notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { parse } from '../lib/validate';
import { logActivity } from '../services/activity';

/**
 * Print & Invoice settings belong to whoever manages invoice templates (`settings_invoice_templates`),
 * not to General settings: they decide what every invoice prints. Anyone signed in may READ them
 * (they arrive with GET /api/settings) — an invoice viewer needs them to render, not to change them.
 */
const PRINT_PERMISSION = 'settings_invoice_templates';

const kindParam = (req: { params: unknown }): PrintAssetKind => {
  const { kind } = req.params as { kind: string };
  const k = String(kind).toUpperCase();
  if (!(PRINT_ASSET_KINDS as readonly string[]).includes(k)) throw notFound('Print image');
  return k as PrintAssetKind;
};

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: app.authenticate }, async (req) => ok(await getSettings(req.user.tenantId)));
  app.put('/api/settings', { preHandler: app.requirePermission('settings_general', 'update') }, async (req) => {
    const patch = parse(appSettingsSchema, req.body ?? {});
    // Print settings have their own endpoint and permission, and the template-seed marker is the
    // server's own: General never changes either (it posts back the whole object it read).
    delete (patch as { print?: unknown }).print;
    delete (patch as { invoiceTemplateSeeds?: unknown }).invoiceTemplateSeeds;
    const next = await updateSettings(req.user.tenantId, patch);
    await logActivity(req, 'settings', null, 'updated', 'General settings updated', { keys: Object.keys(patch) });
    return ok(next, 'Settings saved successfully');
  });

  /** Print & Invoice settings — the whole object, validated strictly (docs/INVOICE_TEMPLATES.md). */
  app.put('/api/settings/print', { preHandler: app.requirePermission(PRINT_PERMISSION, 'update') }, async (req) => {
    const print = parse(printSettingsSchema, req.body ?? {});
    const next = await updateSettings(req.user.tenantId, { print });
    await logActivity(req, 'settings', null, 'updated', 'Print & invoice settings updated', { accent: print.accent, copyLabel: print.copyLabel });
    return ok(next.print, 'Print settings saved');
  });

  /**
   * The tenant's company profile (its default company) — what the app shell brands itself with.
   * Every signed-in user needs it to render the sidebar, so it is authentication-only; it holds
   * the company's own letterhead details and nothing internal. Tenant comes from the token.
   */
  app.get('/api/settings/company', { preHandler: app.authenticate }, async (req) => ok(await getCompanyProfile(req.user.tenantId)));

  /**
   * Print images of the default company — SIGNATURE and FOOTER. Reading needs only a session (every
   * invoice preview draws them), always inside the caller's tenant; `?v=<version>` changes with each
   * upload, so the response may be cached. Changing them is a Print settings edit.
   */
  app.get('/api/settings/print-assets/:kind', { preHandler: app.authenticate }, async (req, reply) => {
    const asset = await getPrintAsset(req.user.tenantId, kindParam(req));
    return reply.header('content-type', asset.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=31536000, immutable').send(asset.data);
  });
  app.put('/api/settings/print-assets/:kind', { preHandler: app.requirePermission(PRINT_PERMISSION, 'update') }, async (req) => {
    const kind = kindParam(req);
    const label = PRINT_ASSET_LABELS[kind].toLowerCase();
    if (!req.isMultipart()) throw validation(`Upload the ${label} as a multipart file`);
    // One byte past the limit: the multipart reader truncates an oversized file rather than always throwing.
    const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } });
    if (!file) throw validation(`Choose a ${label} file to upload`);
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw validation(`The ${label} must be 1 MB or smaller`);
      throw e;
    }
    if (file.file.truncated || data.length > LOGO_MAX_BYTES) throw validation(`The ${label} must be 1 MB or smaller`);
    const saved = await savePrintAsset(req.user.tenantId, kind, data);
    await logActivity(req, 'company', saved.company.id, 'updated', `${PRINT_ASSET_LABELS[kind]} updated: ${saved.company.name}`, { kind, contentType: saved.asset.contentType, bytes: data.length });
    return ok(saved.asset, `${PRINT_ASSET_LABELS[kind]} saved`);
  });
  app.delete('/api/settings/print-assets/:kind', { preHandler: app.requirePermission(PRINT_PERMISSION, 'update') }, async (req) => {
    const kind = kindParam(req);
    const { company, removed } = await deletePrintAsset(req.user.tenantId, kind);
    if (removed) await logActivity(req, 'company', company.id, 'updated', `${PRINT_ASSET_LABELS[kind]} removed: ${company.name}`, { kind });
    return ok(null, `${PRINT_ASSET_LABELS[kind]} removed`);
  });
}
