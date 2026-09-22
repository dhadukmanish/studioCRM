import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings, updateSettings } from '../services/settings';
import { ok } from '../lib/respond';
import { logActivity } from '../services/activity';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: app.authenticate }, async (req) => ok(await getSettings(req.user.tenantId)));
  app.put('/api/settings', { preHandler: app.requirePermission('settings_general', 'update') }, async (req) => {
    const patch = z.record(z.any()).parse(req.body ?? {});
    const next = await updateSettings(req.user.tenantId, patch);
    await logActivity(req, 'settings', null, 'updated', 'General settings updated', { keys: Object.keys(patch) });
    return ok(next, 'Settings saved successfully');
  });
}
