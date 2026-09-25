// Checks the `git add` .env rule in guard-bash.mjs. Run: node --test .claude/hooks/guard-bash.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hook = fileURLToPath(new URL('./guard-bash.mjs', import.meta.url));
const blocked = (command) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }) }).status === 2;

const MUST_BLOCK = [
  'apps/api/.env',
  '.env',
  'apps/api/.env.local',
  'apps/api/.env.production',
  'foo/.env.development',
  '"apps/api/.env"',
  'apps/api/.env.example.bak',
  'apps/api/.env.example apps/api/.env',
];
const MUST_ALLOW = ['apps/api/.env.example', '.env.example', 'docs/environment.md', '"apps/api/.env.example"'];

for (const path of MUST_BLOCK) test(`blocks git add ${path}`, () => assert.equal(blocked(`git add ${path}`), true));
for (const path of MUST_ALLOW) test(`allows git add ${path}`, () => assert.equal(blocked(`git add ${path}`), false));
