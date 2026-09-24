import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';

export default fp(async function errorPlugin(app: FastifyInstance) {
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, timestamp: new Date().toISOString() } });
    }
    const anyErr = err as any;
    if (anyErr?.code === '23505') {
      return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'A record with the same value already exists', timestamp: new Date().toISOString() } });
    }
    req.log.error(err);
    const status = anyErr.statusCode && anyErr.statusCode >= 400 ? anyErr.statusCode : 500;
    return reply.status(status).send({ error: { code: status === 500 ? 'INTERNAL' : 'ERROR', message: status === 500 ? 'Something went wrong' : err.message, timestamp: new Date().toISOString() } });
  });
  /**
   * One not-found handler for the whole app.
   *
   * When a web build is being served from this origin (`plugins/web.ts`), a GET that is not an
   * API path and not a real file is a React ROUTE — `/modules/billing/new` refreshed in the
   * browser — and must return the app shell. Anything under `/api/` stays a JSON 404 whatever
   * else is mounted, so a mistyped endpoint can never answer with HTML.
   */
  app.setNotFoundHandler((req, reply) => {
    if (app.spaFallback && req.method === 'GET' && !req.url.startsWith('/api/')) return app.spaFallback(req, reply);
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found', timestamp: new Date().toISOString() } });
  });
});
