import { strToU8, zipSync } from 'fflate';
import { asc, eq, is } from 'drizzle-orm';
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { db, schema } from '../db/client';
import { toCsv, type CsvValue } from '../lib/csv';
import { notFound } from '../lib/errors';
import { platformToday } from './subscriptions';

/*
 * One studio's data backup (docs/SUBSCRIPTIONS.md → Backups). Built only for the platform panel.
 *
 * Every table that carries `tenant_id` is included automatically — a table added later is in the
 * next backup without touching this file — except the ones below. Each table becomes one CSV
 * (opens in Excel, formula-injection guarded) and all of them together one backup.json with exact
 * values (numbers as strings, binary as base64) for a future restore.
 */

/** Not the studio's business data, or secret: platform billing, invoice-link token hashes. */
const EXCLUDED_TABLES = new Set(['tenant_subscriptions', 'public_invoice_links']);
/** Never leaves the server, in any backup. */
const EXCLUDED_COLUMNS: Record<string, string[]> = { users: ['password_hash'] };

interface TenantTable {
  name: string;
  table: PgTable;
  tenantCol: PgColumn;
  columns: { key: string; name: string }[];
  orderCol?: PgColumn;
}

/** Every schema table scoped by tenant_id, found once. */
const tenantTables: TenantTable[] = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .flatMap((table): TenantTable[] => {
    const cfg = getTableConfig(table);
    const cols = Object.entries(table as unknown as Record<string, PgColumn>).filter(([, c]) => c && typeof c === 'object' && 'columnType' in c);
    const tenant = cols.find(([, c]) => c.name === 'tenant_id');
    if (!tenant || EXCLUDED_TABLES.has(cfg.name)) return [];
    const hidden = EXCLUDED_COLUMNS[cfg.name] ?? [];
    return [{
      name: cfg.name,
      table,
      tenantCol: tenant[1],
      columns: cols.filter(([, c]) => !hidden.includes(c.name)).map(([key, c]) => ({ key, name: c.name })),
      orderCol: cols.find(([, c]) => c.name === 'created_at')?.[1],
    }];
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** JSON-safe value: Buffer → base64, Date → ISO; everything else as Drizzle returns it. */
function jsonValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { base64: v.toString('base64') };
  if (v instanceof Date) return v.toISOString();
  return v;
}

function csvValue(v: unknown): CsvValue {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return `[binary, ${v.length} bytes — see backup.json]`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function buildStudioBackup(tenantId: string) {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  if (!tenant) throw notFound('Studio');

  const files: Record<string, Uint8Array> = {};
  const data: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};

  for (const t of tenantTables) {
    const q = db.select().from(t.table).where(eq(t.tenantCol, tenantId));
    const rows = (await (t.orderCol ? q.orderBy(asc(t.orderCol)) : q)) as Record<string, unknown>[];
    counts[t.name] = rows.length;
    data[t.name] = rows.map((r) => Object.fromEntries(t.columns.map((c) => [c.name, jsonValue(r[c.key])])));
    files[`csv/${t.name}.csv`] = strToU8(toCsv(t.columns.map((c) => c.name), rows.map((r) => t.columns.map((c) => csvValue(r[c.key])))));
  }

  const exportedOn = platformToday();
  const meta = {
    format: 'studiocrm-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    studio: { id: tenant.id, name: tenant.name, slug: tenant.slug, createdAt: tenant.createdAt.toISOString() },
    tables: counts,
  };
  files['backup.json'] = strToU8(JSON.stringify({ ...meta, data }, null, 2));
  files['README.txt'] = strToU8(
    [
      `StudioCRM data backup — ${tenant.name}`,
      `Exported: ${meta.exportedAt}`,
      '',
      'csv/         one file per table; opens in Excel (UTF-8). Amounts are exact decimals.',
      'backup.json  every table with exact values (binary images as base64), for a restore.',
      '',
      'Passwords are not included. Rows per table:',
      ...Object.entries(counts).map(([n, c]) => `  ${n}: ${c}`),
      '',
    ].join('\r\n'),
  );

  return { zip: Buffer.from(zipSync(files, { level: 6 })), fileName: `${tenant.slug}-backup-${exportedOn}.zip`, counts, tenant };
}
