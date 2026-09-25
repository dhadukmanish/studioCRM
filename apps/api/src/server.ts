import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import authPlugin from './plugins/auth';
import errorPlugin from './plugins/errors';
import webPlugin from './plugins/web';
import { registerRoutes } from './routes';
import { listenTarget, describeTarget } from './lib/listen';
import { db } from './db/client';
import { sql } from 'drizzle-orm';
import { ok } from './lib/respond';
import { redactPublicToken } from './services/publicInvoiceLinks';

/**
 * Which build this is. Both values are replaced at bundle time by `build.mjs`; running from
 * source in development they are simply undefined, which reads as "dev".
 */
const VERSION = { commit: process.env.BUILD_COMMIT ?? 'dev', builtAt: process.env.BUILD_TIME ?? null };

/**
 * Is the database reachable? Answers only `up` or `down` — never the host, the user, the
 * driver's message or a stack trace. `/api/health` is public, so everything it returns is
 * public, and a failing database must not narrate itself to the internet.
 */
async function dbStatus() {
  try {
    await db.execute(sql`select 1`);
    return 'up' as const;
  } catch {
    return 'down' as const;
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Fastify's own request line, with a public invoice token cut out of the URL: a full token in
      // a log file would be a working link to a customer's invoice (routes/publicInvoice.ts).
      serializers: {
        req: (req: { method: string; url: string; host?: string; ip?: string }) => ({ method: req.method, url: redactPublicToken(req.url), host: req.host, remoteAddress: req.ip }),
      },
    },
    trustProxy: true,
  });
  await app.register(cors, { origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','), credentials: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'change-me-in-production' });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(errorPlugin);
  await app.register(authPlugin);
  /**
   * Liveness for the deployment check, and the one place a running instance says which build
   * it is. Deliberately unauthenticated and deliberately thin: status, database reachability,
   * the commit it was built from and when. No environment, no connection string, no versions
   * of anything a probe could use.
   */
  app.get('/api/health', async () => ok({ status: 'up', db: await dbStatus(), version: VERSION.commit, builtAt: VERSION.builtAt, time: new Date().toISOString() }));
  await registerRoutes(app);
  /**
   * Last, so the SPA fallback is only ever reached by a request no API route claimed. In
   * development this does nothing — Vite serves the app and proxies `/api` here.
   */
  await app.register(webPlugin);
  return app;
}

// Where to listen, and why it is not as simple as Number(process.env.PORT): see lib/listen.ts.
const listen = listenTarget(process.env.PORT);

buildApp()
  .then((app) => app.listen(listen))
  .then(() => console.log(`API listening on ${describeTarget(listen)} (build ${VERSION.commit})`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
