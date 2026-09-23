import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accountDetailFor, accountDetailSchemas, type AccountDetailKind, type AccountInput } from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { notFound, validation } from '../lib/errors';

/**
 * Account Master business rules. The route validates the common fields and authorizes; this
 * owns everything that touches more than one row — resolving the Account Group, deciding
 * which detail block that group drives, and writing the account and its detail atomically.
 *
 * Accounting FOUNDATION only: nothing here posts a ledger entry, allocates profit, calculates
 * interest or maintains a running balance.
 */

/** Storage kind -> the table that holds that block. `party` serves CLIENT and EXPOSER/PARTY alike. */
const DETAIL_TABLES = {
  bank: schema.accountBankDetails,
  employee: schema.accountEmployeeDetails,
  loan: schema.accountLoanDetails,
  partner: schema.accountPartnerDetails,
  party: schema.accountPartyDetails,
} satisfies Record<AccountDetailKind, unknown>;

const DETAIL_KINDS = Object.keys(DETAIL_TABLES) as AccountDetailKind[];

/** Detail fields backed by a `numeric` column — written at fixed scale, read back as numbers. */
const NUMERIC_DETAIL_FIELDS = new Set(['salary', 'commission', 'interestRate', 'profitPercent', 'lossPercent', 'rate']);

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ------------------------------------------------------------------ reads -- */

/** The account group an account is (or would be) filed under, proven to belong to this tenant. */
async function resolveGroup(exec: Executor, tenantId: string, accountGroupId: string) {
  const [group] = await exec
    .select({ id: schema.accountGroups.id, groupName: schema.accountGroups.groupName, headGroup: schema.accountGroups.headGroup })
    .from(schema.accountGroups)
    .where(and(eq(schema.accountGroups.id, accountGroupId), eq(schema.accountGroups.tenantId, tenantId)))
    .limit(1);
  /**
   * `accounts_group_tenant_fk` already makes a cross-tenant group impossible; this only turns
   * a database error into a message the form can attach to the right field.
   */
  if (!group) throw validation('Select a valid account group', [{ path: ['accountGroupId'], message: 'This account group does not exist' }]);
  return group;
}

/**
 * Friendly duplicate message. `accounts_tenant_name_lower_idx` is the real guard — a race that
 * slips past this check still fails at the database and surfaces as a 409.
 */
async function assertNameFree(exec: Executor, tenantId: string, accountName: string, exceptId?: string) {
  const [clash] = await exec
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.tenantId, tenantId), sql`lower(${schema.accounts.accountName}) = lower(${accountName})`, exceptId ? ne(schema.accounts.id, exceptId) : undefined))
    .limit(1);
  if (clash) throw validation(`An account named "${accountName}" already exists`, [{ path: ['accountName'], message: 'This account name is already used' }]);
}

/** The referenced Item must be this tenant's. The composite FK enforces it; this names the field. */
async function assertItemExists(exec: Executor, tenantId: string, itemId: string) {
  const [item] = await exec
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(and(eq(schema.items.id, itemId), eq(schema.items.tenantId, tenantId)))
    .limit(1);
  if (!item) throw validation('Select a valid item', [{ path: ['detail', 'itemId'], message: 'This item does not exist' }]);
}

/* ----------------------------------------------------------------- writes -- */

/**
 * Validate the submitted detail against the block the group actually drives. Anything sent for
 * a different block is dropped here rather than trusted: when a user fills in Bank Details and
 * then switches the group to CASH, the stale values must not reach the database even if the
 * browser sent them.
 */
function validateDetail(kind: AccountDetailKind | null, raw: unknown) {
  // A request that does not mention `detail` is not asking for it to be blanked — it leaves
  // whatever the account already has. Sending `{}` is how a caller clears every field.
  if (!kind || raw === undefined) return null;
  // Wrapping the block keeps zod's issue paths as `detail.<field>`, which is what the form binds
  // to. Zod strips unknown keys, so a field belonging to another block never reaches a column.
  const { detail } = parse(z.object({ detail: accountDetailSchemas[kind] }), { detail: raw ?? {} });
  return detail as Record<string, unknown>;
}

/** Row values for a detail table: numbers go in at the column's fixed scale, never as floats. */
const detailRow = (detail: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, NUMERIC_DETAIL_FIELDS.has(k) && typeof v === 'number' ? v.toFixed(2) : v]));

/**
 * Replace an account's detail: write the block its group drives and remove every other one, so
 * a group change never leaves an orphaned Bank Details row behind an account that is now CASH.
 * A brand-new account has nothing to clear.
 */
async function writeDetail(exec: Executor, tenantId: string, accountId: string, kind: AccountDetailKind | null, detail: Record<string, unknown> | null, isNew: boolean) {
  if (!isNew) {
    for (const other of DETAIL_KINDS) {
      if (other === kind) continue;
      const table = DETAIL_TABLES[other] as any;
      await exec.delete(table).where(and(eq(table.accountId, accountId), eq(table.tenantId, tenantId)));
    }
  }
  if (!kind) return;
  const table = DETAIL_TABLES[kind] as any;
  const values = detailRow(detail ?? {});
  await exec
    .insert(table)
    .values({ ...values, accountId, tenantId })
    .onConflictDoUpdate({ target: table.accountId, set: { ...values, updatedAt: new Date() } });
}

/* -------------------------------------------------------------- public API -- */

export interface AccountRecord {
  id: string;
  tenantId: string;
  accountGroupId: string;
  accountName: string;
  openingAmount: number;
  openingSide: string;
  remark: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  groupName: string;
  headGroup: string;
  /** Which detail block this account's group drives, or null for a common-fields-only group. */
  detailKind: AccountDetailKind | null;
  detail: Record<string, unknown> | null;
}

/** API shape: `numeric` comes back from Postgres as a string. */
export const shapeAccount = <T extends { openingAmount: unknown }>(row: T) => ({ ...row, openingAmount: Number(row.openingAmount) });
const shapeDetail = (row: Record<string, any> | undefined) => {
  if (!row) return null;
  const { accountId, tenantId, createdAt, updatedAt, ...rest } = row;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, NUMERIC_DETAIL_FIELDS.has(k) && v !== null ? Number(v) : v]));
};

/** One account with its group's display fields and whichever detail block applies. */
export async function getAccount(tenantId: string, id: string): Promise<AccountRecord> {
  const [row] = await db
    .select({ a: schema.accounts, groupName: schema.accountGroups.groupName, headGroup: schema.accountGroups.headGroup })
    .from(schema.accounts)
    .innerJoin(schema.accountGroups, eq(schema.accountGroups.id, schema.accounts.accountGroupId))
    .where(and(eq(schema.accounts.id, id), eq(schema.accounts.tenantId, tenantId)))
    .limit(1);
  if (!row) throw notFound('Account');
  const kind = accountDetailFor(row.groupName)?.kind ?? null;
  let detail: Record<string, unknown> | null = null;
  if (kind) {
    const table = DETAIL_TABLES[kind] as any;
    const [d] = await db.select().from(table).where(and(eq(table.accountId, id), eq(table.tenantId, tenantId))).limit(1);
    detail = shapeDetail(d);
    /**
     * The item's name rides along so the edit form can still show an item that was later
     * deactivated — the active-items lookup no longer offers it, and a bare id would read as
     * "no item" and silently drop the link on the next save.
     */
    if (detail && typeof detail.itemId === 'string') {
      const [item] = await db.select({ itemName: schema.items.itemName }).from(schema.items).where(and(eq(schema.items.id, detail.itemId), eq(schema.items.tenantId, tenantId))).limit(1);
      detail.itemName = item?.itemName ?? null;
    }
  }
  return { ...shapeAccount(row.a), groupName: row.groupName, headGroup: row.headGroup, detailKind: kind, detail } as AccountRecord;
}

/**
 * Create or update an account and its detail block in a single transaction: a failed detail
 * write must never leave a half-created account behind.
 */
export async function saveAccount(tenantId: string, body: Partial<AccountInput>, rawDetail: unknown, existingId?: string) {
  return db.transaction(async (tx) => {
    let existing: typeof schema.accounts.$inferSelect | undefined;
    if (existingId) {
      [existing] = await tx.select().from(schema.accounts).where(and(eq(schema.accounts.id, existingId), eq(schema.accounts.tenantId, tenantId)));
      if (!existing) throw notFound('Account');
    }

    const accountGroupId = body.accountGroupId ?? existing?.accountGroupId;
    const accountName = body.accountName ?? existing?.accountName;
    if (!accountGroupId || !accountName) throw validation('Account group and account name are required');

    const group = await resolveGroup(tx, tenantId, accountGroupId);
    await assertNameFree(tx, tenantId, accountName, existing?.id);

    const kind = accountDetailFor(group.groupName)?.kind ?? null;
    const detail = validateDetail(kind, rawDetail);
    if (kind === 'party' && typeof detail?.itemId === 'string') await assertItemExists(tx, tenantId, detail.itemId);

    const row: Record<string, unknown> = { ...body };
    if (body.openingAmount !== undefined) row.openingAmount = Number(body.openingAmount).toFixed(2);

    const [saved] = existing
      ? await tx.update(schema.accounts).set({ ...row, updatedAt: new Date() }).where(eq(schema.accounts.id, existing.id)).returning()
      : await tx.insert(schema.accounts).values({ ...(row as any), tenantId }).returning();

    await writeDetail(tx, tenantId, saved.id, kind, detail, !existing);

    return {
      ...shapeAccount(saved),
      groupName: group.groupName,
      headGroup: group.headGroup,
      detailKind: kind,
      detail,
      /** what changed, for the audit entry */
      changed: Object.keys(row),
      previous: existing,
    };
  });
}
