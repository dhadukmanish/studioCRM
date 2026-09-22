#!/usr/bin/env node
/**
 * PreToolUse(Bash) guard for StudioCRM.
 *
 * Blocks the small set of commands that are irreversible or that leak secrets, and tells
 * Claude to ask the user first. Exit 2 = block, stderr goes back to Claude.
 * It is a safety net, not a policy engine — keep the list short and specific.
 *
 * Wired up in .claude/settings.json.
 */
let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let cmd = '';
try {
  cmd = JSON.parse(raw)?.tool_input?.command ?? '';
} catch {
  process.exit(0); // unparseable input is not our problem — let the call through
}

const RULES = [
  {
    // git push --force / -f / refspec with a leading +
    test: /\bgit\s+push\b[^\n]*?(--force(-with-lease)?\b|\s-f\b|\s\+[\w./-]+:)/,
    why: 'Force-pushing can destroy commits other clones already have.',
  },
  {
    test: /\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+push\b[^\n]*--mirror\b/,
    why: 'Rewriting or mirroring shared history is irreversible for everyone who has cloned.',
  },
  {
    test: /\bgit\s+reset\s+--hard\b/,
    why: 'reset --hard discards uncommitted work, which may include the user\'s own changes.',
  },
  {
    test: /\bgit\s+clean\b[^\n]*-[a-z]*[dx]/,
    why: 'git clean deletes untracked files — this working tree holds untracked files the user kept on purpose.',
  },
  {
    test: /\bgit\s+add\b[^\n]*(^|[\s/])\.env\b/,
    why: 'apps/api/.env holds live credentials and must never be committed.',
  },
  {
    test: /\bdrizzle-kit\s+push\b/,
    why: 'This project migrates with db:generate + db:migrate. drizzle-kit push alters the database without a reviewable migration.',
  },
  {
    // only running the seed, not reading or grepping the file
    test: /(\brun\s+db:seed\b|\bdb:seed\b(?!['"`])|(?:^|[|&;]\s*)(?:npx\s+)?(?:tsx|node|ts-node)\s+\S*db\/seed\.ts)/,
    why: 'Seeding overwrites data and the API points at a shared hosted database.',
  },
  {
    test: /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+(TABLE\s+)?\w)/i,
    why: 'This destroys data irreversibly.',
  },
  {
    test: /\bDELETE\s+FROM\s+[\w."]+\s*(;|$)/i,
    why: 'DELETE without a WHERE clause empties the table.',
  },
];

const hit = RULES.find((r) => r.test.test(cmd));
if (hit) {
  console.error(
    `Blocked by .claude/hooks/guard-bash.mjs: ${hit.why}\n` +
      `Command: ${cmd}\n` +
      `Stop and ask the user for explicit approval, stating exactly what would be lost. ` +
      `If they approve, they can run it themselves or lift this guard.`,
  );
  process.exit(2);
}
process.exit(0);
