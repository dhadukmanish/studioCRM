// Bundles the API (including the workspace `@diamondbill/shared` package) into dist/server.js.
// Third-party dependencies stay external and are loaded from node_modules at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@diamondbill/'));
for (const entry of ['src/server.ts', 'src/db/migrate.ts', 'src/db/seed.ts']) {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: 'dist', outbase: 'src', sourcemap: true, external, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
}
console.log('API bundled → dist/');
