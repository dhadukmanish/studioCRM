import type { FastifyInstance } from 'fastify';
import { appSettingsSchema } from '@erp/shared';
import { getSettings, updateSettings } from '../services/settings';
import { getCompanyProfile } from '../services/company';
import { ok } from '../lib/respond';
import { parse } from '../lib/validate';
import { logActivity } from '../services/activity';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: app.authenticate }, async (req) => ok(await getSettings(req.user.tenantId)));
  app.put('/api/settings', { preHandler: app.requirePermission('settings_general', 'update') }, async (req) => {
    const patch = parse(appSettingsSchema, req.body ?? {});
    const next = await updateSettings(req.user.tenantId, patch);
    await logActivity(req, 'settings', null, 'updated', 'General settings updated', { keys: Object.keys(patch) });
    return ok(next, 'Settings saved successfully');
  });

  /**
   * The tenant's company profile (its default company) — what the app shell brands itself with.
   * Every signed-in user needs it to render the sidebar, so it is authentication-only; it holds
   * the company's own letterhead details and nothing internal. Tenant comes from the token.
   */
  app.get('/api/settings/company', { preHandler: app.authenticate }, async (req) => ok(await getCompanyProfile(req.user.tenantId)));
}
