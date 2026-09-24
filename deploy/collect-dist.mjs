// Puts the built web app where the built API expects to serve it from.
//
//   apps/web/dist  ->  apps/api/dist/public
//
// After this, `apps/api/dist` is the whole deployable application: server.js plus the public/
// folder beside it, which is exactly what `apps/api/src/plugins/web.ts` looks for. One folder
// to ship, and `node apps/api/dist/server.js` runs the entire thing — the same command whether
// it runs in the host's container, from a zip, or locally.
//
// Run by the root `pnpm build` after every package has built. Kept out of the API's own build
// so that `pnpm --filter @erp/api build` still means "build the API".
import { cp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'apps/web/dist');
const to = path.join(root, 'apps/api/dist/public');

try {
  await access(from);
} catch {
  console.error(`collect-dist: ${from} does not exist — run the web build first`);
  process.exit(1);
}

// Replaced outright, never merged: a stale asset from an earlier build lingering in public/
// is how a deployment ends up serving two versions of the same app.
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log('web build → apps/api/dist/public');
