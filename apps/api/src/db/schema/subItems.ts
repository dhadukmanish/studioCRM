import { pgTable, uuid, text, numeric, boolean, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, ts, tenantRef } from './core';
import { items } from './items';

/**
 * Sub Item Master — the billable products under an Item Master row
 * (Photography → "Wedding Shoot" ₹2500). GST % and HSN live on the parent `items` row and
 * are never copied here; billing reaches them through `itemId`.
 *
 * Audited through `activity_logs`, like Item Master — no createdBy/updatedBy columns.
 */
export const subItems = pgTable(
  'sub_items',
  {
    id: id(),
    tenantId: tenantRef(),
    itemId: uuid('item_id').notNull(),
    productName: text('product_name').notNull(),
    /** Money — fixed scale, never a float. 10 digits before the point is far past any studio price. */
    rate: numeric('rate', { precision: 12, scale: 2 }).notNull(),
    remark: text('remark'),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [
    /**
     * The parent reference carries the tenant, so a row can only ever point at an Item of its
     * own tenant — cross-tenant attachment is impossible, not merely checked for. RESTRICT
     * because Billing will reference these rows: an Item with products must be deactivated,
     * not deleted out from under them.
     */
    foreignKey({ columns: [t.itemId, t.tenantId], foreignColumns: [items.id, items.tenantId], name: 'sub_items_item_tenant_fk' }).onDelete('restrict'),
    // Business key: one product name per parent item per tenant, case-insensitive. Also the
    // final guard against two concurrent creates racing past the application-level check.
    uniqueIndex('sub_items_item_product_lower_idx').on(t.tenantId, t.itemId, sql`lower(${t.productName})`),
    // List screen: tenant predicate + default "recently updated first" sort.
    index('sub_items_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    /**
     * Redundant on its own (id is already the primary key), but it is the target `bill_items`
     * needs in order to reference (sub_item_id, tenant_id) together — the same tenant-safe
     * composite key the rest of the schema uses. Billing references these rows with RESTRICT.
     */
    unique('sub_items_id_tenant_uk').on(t.id, t.tenantId),
    check('sub_items_rate_non_negative_check', sql`${t.rate} >= 0`),
    check('sub_items_product_name_not_blank_check', sql`length(btrim(${t.productName})) > 0`),
  ],
);
