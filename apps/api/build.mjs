// Bundles the API into dist/ for production.
//
// Everything is bundled — the workspace `@erp/shared` package AND the third-party
// dependencies — so what ships is a handful of self-contained .js files and NOT a
// node_modules tree. That matters for this project's hosting: the app is deployed to Windows
// hosting over FTP, where uploading tens of thousands of dependency files is slow, fragile and
// impossible to make atomic. See `docs/DEPLOYMENT.md`.
//
// Only Node's own builtins stay external. `@erp/shared` publishes TypeScript source
// (`main: ./src/index.ts`), so leaving it external produced a bundle Node could not even
// start — bundling it is what makes `dist/server.js` runnable anywhere.
//
// Source maps are OFF by default: they inline the entire server source, and the deployment
// artifact is served from a public web root. Build with SOURCEMAP=1 when debugging a built
// bundle locally.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

/** Short commit SHA + build time, so a deployed instance can say which build it is. */
function commit() {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const sourcemap = process.env.SOURCEMAP === '1';

for (const entry of ['src/server.ts', 'src/db/migrate.ts', 'src/db/seed.ts']) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir: 'dist',
    outbase: 'src',
    sourcemap,
    // Nothing external: Node builtins are resolved by `platform: 'node'`, and every runtime
    // dependency is compiled in.
    external: [],
    define: {
      'process.env.BUILD_COMMIT': JSON.stringify(commit()),
      'process.env.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    },
    // Some dependencies (Fastify's plugin loader among them) reach for CommonJS `require`
    // at runtime; ESM output has none, so one is created from the module URL.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}
console.log(`API bundled → dist/ (commit ${commit()}${sourcemap ? ', with source maps' : ''})`);
