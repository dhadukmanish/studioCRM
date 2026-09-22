import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import authPlugin from './plugins/auth';
import errorPlugin from './plugins/errors';
import { registerRoutes } from './routes';
import { ok } from './lib/respond';

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
  await app.register(cors, { origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','), credentials: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'change-me-in-production' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(errorPlugin);
  await app.register(authPlugin);
  app.get('/api/health', async () => ok({ status: 'up', time: new Date().toISOString() }));
  await registerRoutes(app);
  return app;
}

const port = Number(process.env.PORT ?? 4000);
buildApp()
  .then((app) => app.listen({ port, host: '0.0.0.0' }))
  .then(() => console.log(`API listening on http://localhost:${port}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
