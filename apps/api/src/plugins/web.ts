import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Serves the built React app from the SAME origin as the API, when a build is present.
 *
 * This is what makes the production topology one application instead of two. The browser
 * client (`apps/web/src/lib/api.ts`) calls `/api/...` as a RELATIVE url and has no API base
 * url of its own, so serving both from one origin means there is no CORS preflight, no
 * cross-site cookie question, no mixed content and — the failure this rules out entirely — no
 * way for a production bundle to end up calling localhost.
 *
 * In development nothing changes: Vite serves the app on :5173 and proxies `/api` here, no
 * `public/` folder exists next to the API, and this plugin does nothing at all.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Set only when a web build is actually being served. `plugins/errors.ts` calls it so a
     * deep link like `/modules/billing/new` returns the app shell instead of a JSON 404 —
     * see the note there.
     */
    spaFallback?: (req: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply>;
  }
}

/**
 * Where the built web app lives, as an absolute path.
 *
 * `WEB_ROOT` overrides it; the default is `public/` beside the running server file, which is
 * exactly how the deployment package is laid out (`server.js` + `public/`). Resolved from the
 * server file rather than from `process.cwd()` on purpose: under IIS/iisnode the working
 * directory is not reliably the application folder.
 */
function webRoot() {
  if (process.env.WEB_ROOT) return path.resolve(process.env.WEB_ROOT);
  // fileURLToPath, not url.pathname: a pathname is percent-encoded, so an application folder
  // with a space in its name would resolve to a directory that does not exist.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
}

export default fp(async function webPlugin(app: FastifyInstance) {
  const root = webRoot();
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) {
    app.log.info({ root }, 'no web build found — serving the API only');
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // The SPA fallback below owns everything that is not a real file; a wildcard route here
    // would swallow it and answer 404 for every deep link.
    wildcard: false,
    // Off, so the headers set below are the only ones sent: the plugin's own default
    // ("public, max-age=0") otherwise wins and every asset is revalidated on every load.
    cacheControl: false,
    setHeaders(res, filePath) {
      // Vite fingerprints everything under assets/, so those may be cached hard and forever.
      // index.html must NOT be: it is the file that names the current bundle, and a cached
      // copy is how a browser keeps running the previous deployment after an update.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      else res.setHeader('cache-control', 'no-cache');
    },
  });

  /**
   * SPA fallback. `/modules/billing/new` is a route inside the React router, not a file on
   * disk, so refreshing or deep-linking it has to return the app shell and let the browser
   * route. Only GET, and never anything under `/api/` — an unknown API path is a genuine 404
   * and must stay JSON, or a typo'd endpoint would answer with HTML and confuse every caller.
   */
  app.decorate('spaFallback', (req: FastifyRequest, reply: FastifyReply) =>
    reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html'),
  );
  app.log.info({ root }, 'serving the web build from the API origin');
});
