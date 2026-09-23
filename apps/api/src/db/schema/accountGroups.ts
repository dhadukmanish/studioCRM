import { pgTable, text, boolean, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';

/**
 * Account Group Master — how a studio classifies its accounts (CASH, BANK, CUSTOMER, ...).
 * The groups are tenant data; only the head group they are filed under is a fixed set.
 *
 * Classification only. Nothing in this phase posts, balances or reports off these rows.
 * Audited through `activity_logs`, like the other masters.
 */
export const accountGroups = pgTable(
  'account_groups',
  {
    id: id(),
    tenantId: tenantRef(),
    groupName: text('group_name').notNull(),
    /** One of HEAD_GROUPS (`packages/shared/src/enums.ts`) — text, the convention this repo uses for enums. */
    headGroup: text('head_group').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [
    // Business key: one group name per tenant, case-insensitive. Also the final guard against
    // two concurrent create requests racing past the application-level check.
    uniqueIndex('account_groups_tenant_name_lower_idx').on(t.tenantId, sql`lower(${t.groupName})`),
    // List screen: tenant predicate + default "recently updated first" sort.
    index('account_groups_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    /**
     * Redundant on its own (id is already the primary key), but it is the target Account
     * Master will need in order to reference (id, tenant_id) together — the same composite
     * key `sub_items` uses to make a cross-tenant parent structurally impossible.
     */
    unique('account_groups_id_tenant_uk').on(t.id, t.tenantId),
    /**
     * The values are spelled out because drizzle-kit loads this file on its own and cannot
     * resolve `@erp/shared`. HEAD_GROUPS there stays the source of truth and the zod schema is
     * what rejects a bad value; this is the database's last line. Changing the set means
     * editing both, plus a migration.
     */
    check('account_groups_head_group_check', sql`${t.headGroup} IN ('LIABILITIES', 'ASSETS', 'EXPENSES', 'INCOME', 'CASH', 'OTHER')`),
    check('account_groups_group_name_not_blank_check', sql`length(btrim(${t.groupName})) > 0`),
  ],
);
