import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { and, desc, eq } from 'drizzle-orm';
import { getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import { db, schema, type Db } from '../db/client';
import { AppError, notFound, validation } from '../lib/errors';
import { buildStudioBackup, tenantTables, type TenantTable } from './studioBackup';
import { assertLoginIdentityFree } from './subscriptions';

/*
 * Restore one studio from its own backup ZIP (docs/SUBSCRIPTIONS.md → Restore).
 *
 * The studio's current data is REPLACED by the backup's — every tenant_id table the backup service
 * covers is emptied and refilled with the backup's rows (same ids), in one transaction. Rules:
 *   - only into the studio the backup came from (backup.studio.id), never another;
 *   - only while the studio is SUSPENDED, so no studio request can write during the swap;
 *   - the current data is first saved as a snapshot ZIP (studio_restore_snapshots) in the same
 *     transaction — restoring that snapshot undoes the restore;
 *   - passwords are not in backups: a user who still exists keeps the current password; any other
 *     restored user gets an unusable one (reset the owner's from the panel);
 *   - a backup user whose email/username another studio now uses is refused (sign-in is global);
 *   - subscriptions, invoice-link hashes and snapshots are untouched by design; restoring bills
 *     drops their public links (they cascade), which is the revocation rule anyway.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Row = Record<string, unknown>;

const BATCH = 200;
const byName = new Map(tenantTables.map((t) => [t.name, t]));

/** A foreign key from one restored table to another (tenant_id itself excluded). */
interface Edge {
  from: string;
  to: string;
  /** The FK's own columns (DB names) without tenant_id. */
  cols: string[];
  /** Each FK column with the column it references in `to`. */
  pairs: { col: string; ref: string }[];
  nullable: boolean;
}

const edges: Edge[] = tenantTables.flatMap((t) =>
  getTableConfig(t.table).foreignKeys.flatMap((fk) => {
    const ref = fk.reference();
    const to = getTableConfig(ref.foreignTable).name;
    const pairs = ref.columns.map((c, i) => ({ col: c.name, ref: ref.foreignColumns[i].name, notNull: c.notNull })).filter((x) => x.col !== 'tenant_id');
    if (to === t.name || !byName.has(to) || !pairs.length) return [];
    return [{ from: t.name, to, cols: pairs.map((x) => x.col), pairs: pairs.map(({ col, ref }) => ({ col, ref })), nullable: pairs.every((x) => !x.notNull) }];
  }),
);

/**
 * Parents before children. A cycle (bills ↔ appointments) is broken at a nullable FK: those columns
 * are inserted NULL and filled in once every row exists (`deferred`).
 */
function insertPlan(): { order: string[]; deferred: Edge[] } {
  const remaining = new Set(tenantTables.map((t) => t.name));
  let live = [...edges];
  const deferred: Edge[] = [];
  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((n) => !live.some((e) => e.from === n && remaining.has(e.to))).sort();
    if (ready.length) {
      for (const n of ready) remaining.delete(n);
      order.push(...ready);
      continue;
    }
    const breakable = live.find((e) => remaining.has(e.from) && remaining.has(e.to) && e.nullable);
    if (!breakable) throw new Error(`Restore: unbreakable foreign-key cycle among ${[...remaining].join(', ')}`);
    deferred.push(breakable);
    live = live.filter((e) => e !== breakable);
  }
  return { order, deferred };
}
const PLAN = insertPlan();

interface Backup {
  format: string;
  version: number;
  exportedAt: string;
  studio: { id: string; name: string };
  /** Row count per table, written by the backup — a cross-check that no table went missing. */
  tables: Record<string, number>;
  data: Record<string, Row[]>;
}

/** Inflated backup.json may be at most this big — a 20 MB upload must not expand into gigabytes. */
const MAX_JSON_BYTES = 200 * 1024 * 1024;

/** Reads and checks a backup ZIP; throws a 400 naming the problem. */
export function readBackup(zip: Buffer): Backup {
  let files: Record<string, Uint8Array>;
  try {
    // Only backup.json is inflated (the CSVs are for people), and only if its declared size is sane.
    files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === 'backup.json' && f.originalSize <= MAX_JSON_BYTES });
  } catch {
    throw validation('This is not a valid backup ZIP file');
  }
  if (!files['backup.json']) throw validation('backup.json is missing or too large — choose a ZIP made by Download backup');
  if (files['backup.json'].length > MAX_JSON_BYTES) throw validation('backup.json is too large');
  let backup: Backup;
  try {
    backup = JSON.parse(strFromU8(files['backup.json']));
  } catch {
    throw validation('backup.json is damaged');
  }
  if (backup?.format !== 'studiocrm-backup' || backup.version !== 1 || !backup.studio?.id || typeof backup.data !== 'object' || typeof backup.tables !== 'object') throw validation('This file is not a StudioCRM backup (version 1)');
  return backup;
}

/** DB value from a backup value: timestamps back to Date, binary back to Buffer. */
function toDb(column: PgColumn, v: unknown): unknown {
  if (v == null) return v;
  if (column.columnType === 'PgTimestamp' && typeof v === 'string') return new Date(v);
  if (typeof v === 'object' && v !== null && 'base64' in v && column.getSQLType() === 'bytea') return Buffer.from(String((v as { base64: string }).base64), 'base64');
  return v;
}

/**
 * Every table must be present as its counts say, every row must belong to this studio, and every
 * foreign key must point at a row INSIDE this backup — a tampered file could otherwise attach a
 * restored row to another studio's role, user or bill (their ids exist, just elsewhere).
 */
function assertSelfContained(backup: Backup, tenantId: string) {
  for (const [name, rows] of Object.entries(backup.data)) {
    if (!Array.isArray(rows)) throw validation(`backup.json: "${name}" is not a list`);
    if (byName.has(name) && rows.some((r) => r?.tenant_id !== tenantId)) throw validation(`backup.json: "${name}" holds rows of another studio`);
  }
  for (const name of PLAN.order) {
    const rows = backup.data[name];
    const declared = backup.tables[name];
    // Neither listed nor present: the table is newer than the backup and is restored empty.
    if (rows === undefined && declared === undefined) continue;
    if (rows === undefined || declared !== rows.length) throw validation(`backup.json: "${name}" is missing or incomplete — the file may have been edited`);
  }
  const key = (r: Row, cols: string[]) => cols.map((c) => String(r[c])).join('|');
  for (const e of edges) {
    const targets = new Set((backup.data[e.to] ?? []).map((r) => key(r, e.pairs.map((x) => x.ref))));
    for (const r of backup.data[e.from] ?? []) {
      if (e.pairs.some((x) => r[x.col] == null)) continue;
      if (!targets.has(key(r, e.pairs.map((x) => x.col)))) throw validation(`backup.json: a "${e.from}" row points at a "${e.to}" row that is not in this backup`);
    }
  }
}

export async function restoreStudio(tenantId: string, zip: Buffer, adminId: string, adminEmail: string, ip?: string) {
  const backup = readBackup(zip);
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  if (!tenant) throw notFound('Studio');
  if (backup.studio.id !== tenantId) throw validation(`This backup belongs to another studio ("${backup.studio.name}") — it can only be restored into that studio`);
  if (tenant.isActive) throw new AppError('SUB_006', 'Suspend the studio before restoring, so nobody is working in it during the restore', 409);

  assertSelfContained(backup, tenantId);
  const unusable = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

  // Repeatable read: the snapshot and the swap see one consistent state; a concurrent write to these
  // rows makes the restore fail and roll back rather than be silently lost.
  const { counts, usersWithoutPassword } = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ isActive: schema.tenants.isActive }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).for('update');
    if (locked.isActive) throw new AppError('SUB_006', 'Suspend the studio before restoring', 409);
    // The current data, saved first, under the lock and in this transaction's snapshot.
    const snapshot = await buildStudioBackup(tenantId, tx);
    await tx.insert(schema.studioRestoreSnapshots).values({ tenantId, zip: snapshot.zip, sizeBytes: snapshot.zip.length, restoredFrom: backup.exportedAt, createdBy: adminId });

    const hashes = new Map((await tx.select({ id: schema.users.id, h: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.tenantId, tenantId))).map((u) => [u.id, u.h]));

    // Empty: break the cycle, then children before parents.
    for (const e of PLAN.deferred) await nullOut(tx, byName.get(e.from)!, e.cols, tenantId);
    for (const name of [...PLAN.order].reverse()) {
      const t = byName.get(name)!;
      await tx.delete(t.table).where(eq(t.tenantCol, tenantId));
    }

    // Sign-in is global: with this studio's users gone, a restored email/username may not belong to
    // any other studio's user (same check and lock as creating a user).
    for (const u of backup.data.users ?? []) await assertLoginIdentityFree(tx, { email: u.email as string, username: (u.username as string | null) || null }, String(u.id));

    // Refill: parents before children, deferred FK columns NULL first.
    const counts: Record<string, number> = {};
    for (const name of PLAN.order) {
      const t = byName.get(name)!;
      const rows = backup.data[name] ?? [];
      const nulled = PLAN.deferred.filter((e) => e.from === name).flatMap((e) => e.cols);
      const values = rows.map((r) => {
        const v: Row = {};
        for (const c of t.allColumns) if (c.name in r) v[c.key] = nulled.includes(c.name) ? null : toDb(c.column, r[c.name]);
        if (name === 'users') v.passwordHash = hashes.get(String(r.id)) ?? unusable;
        return v;
      });
      try {
        for (let i = 0; i < values.length; i += BATCH) await tx.insert(t.table).values(values.slice(i, i + BATCH) as never);
      } catch (e) {
        // An id now used elsewhere, or a backup older than a NOT NULL column — name the table, not "500".
        throw validation(`Could not restore "${name}": ${(e as { detail?: string }).detail ?? (e as Error).message}`);
      }
      counts[name] = values.length;
    }
    for (const e of PLAN.deferred) {
      const t = byName.get(e.from)!;
      const idCol = t.allColumns.find((c) => c.name === 'id')!.column;
      const cols = t.allColumns.filter((c) => e.cols.includes(c.name));
      for (const r of backup.data[e.from] ?? []) {
        if (cols.every((c) => r[c.name] == null)) continue;
        await tx.update(t.table).set(Object.fromEntries(cols.map((c) => [c.key, r[c.name]])) as never).where(eq(idCol, r.id as string));
      }
    }

    await tx.insert(schema.activityLogs).values({
      tenantId,
      entityType: 'backup',
      action: 'restored',
      description: `Data restored from the backup of ${backup.exportedAt} by the StudioCRM provider (${adminEmail})`,
      meta: { tables: counts, platformAdminId: adminId },
      ipAddress: ip ?? null,
    });
    const usersWithoutPassword = (backup.data.users ?? []).filter((u) => !hashes.has(String(u.id))).length;
    return { counts, usersWithoutPassword };
  }, { isolationLevel: 'repeatable read' });

  return { counts, restoredFrom: backup.exportedAt, usersWithoutPassword };
}

async function nullOut(tx: Tx, t: TenantTable, cols: string[], tenantId: string) {
  const set = Object.fromEntries(t.allColumns.filter((c) => cols.includes(c.name)).map((c) => [c.key, null]));
  await tx.update(t.table).set(set as never).where(eq(t.tenantCol, tenantId));
}

export async function listRestoreSnapshots(tenantId: string) {
  const s = schema.studioRestoreSnapshots;
  return db
    .select({ id: s.id, sizeBytes: s.sizeBytes, restoredFrom: s.restoredFrom, createdAt: s.createdAt, createdBy: schema.platformAdmins.email })
    .from(s)
    .leftJoin(schema.platformAdmins, eq(schema.platformAdmins.id, s.createdBy))
    .where(eq(s.tenantId, tenantId))
    .orderBy(desc(s.createdAt));
}

export async function getRestoreSnapshot(tenantId: string, id: string) {
  const [row] = await db.select().from(schema.studioRestoreSnapshots).where(and(eq(schema.studioRestoreSnapshots.id, id), eq(schema.studioRestoreSnapshots.tenantId, tenantId)));
  if (!row) throw notFound('Snapshot');
  return row;
}
