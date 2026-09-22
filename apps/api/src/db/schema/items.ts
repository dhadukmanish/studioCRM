import { pgTable, text, numeric, boolean, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';

/**
 * Item Master — what the studio sells or produces (Photography, Album Printing, ...).
 * Stores only the configured GST rate; nothing here calculates tax.
 * No custom-fields engine and no createdBy/updatedBy — this module is audited
 * through `activity_logs`.
 */
export const items = pgTable(
  'items',
  {
    id: id(),
    tenantId: tenantRef(),
    itemName: text('item_name').notNull(),
    /** Identifier, never numeric: HSN codes are strings and leading zeros are significant. */
    hsnCode: text('hsn_code').notNull(),
    /** Percentage slab (0 / 5 / 12 / 18 / 28), fixed scale — never a float. */
    gstRate: numeric('gst_rate', { precision: 5, scale: 2 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [
    // Business key: one item name per tenant, case-insensitive. Also the final guard
    // against two concurrent create requests racing past an application-level check.
    uniqueIndex('items_tenant_name_lower_idx').on(t.tenantId, sql`lower(${t.itemName})`),
    // List screen: tenant predicate + default "recently updated first" sort.
    index('items_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    // Redundant on its own (id is already the primary key), but it is the target a child table
    // needs in order to reference (id, tenant_id) together — see `sub_items`, whose composite
    // foreign key makes attaching a product to another tenant's item structurally impossible.
    unique('items_id_tenant_uk').on(t.id, t.tenantId),
    check('items_gst_rate_range_check', sql`${t.gstRate} >= 0 AND ${t.gstRate} <= 100`),
    check('items_item_name_not_blank_check', sql`length(btrim(${t.itemName})) > 0`),
    check('items_hsn_code_not_blank_check', sql`length(btrim(${t.hsnCode})) > 0`),
  ],
);
