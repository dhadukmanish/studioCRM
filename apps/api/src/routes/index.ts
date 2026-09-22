import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth';
import { roleRoutes } from './roles';
import { userRoutes } from './users';
import { orgRoutes } from './org';
import { customFieldRoutes } from './customFields';
import { settingsRoutes } from './settings';
import { prefRoutes } from './prefs';
import { sampleRoutes } from './sample';

/** Register every route module here. Feature modules: add one line. */
export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(roleRoutes);
  await app.register(userRoutes);
  await app.register(orgRoutes);
  await app.register(customFieldRoutes);
  await app.register(settingsRoutes);
  await app.register(prefRoutes);
  await app.register(sampleRoutes); // ← delete when you add real modules
}
