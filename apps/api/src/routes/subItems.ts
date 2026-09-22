import type { FastifyInstance } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { subItemSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';

/** API shape: rate is numeric in Postgres, which Drizzle returns as a string. */
const shape = (row: Record<string, any>) => ({ ...row, rate: Number(row.rate) });

/**
 * Sub Item Master — the billable products under an Item Master row. The CRUD factory owns
 * list/get/create/update/delete, the permission check and the tenant predicate; the list
 * joins `items` once so every row carries its parent's name without a query per row.
 *
 * GST % and HSN are deliberately absent: they belong to the parent item, and billing will
 * read them through `itemId`.
 */
export async function subItemRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.subItems,
    base: '/api/masters/sub-items',
    permission: 'masters_sub_items',
    schema: subItemSchema,
    label: 'Sub Item',
    labelField: 'productName',
    join: { table: schema.items, on: eq(schema.subItems.itemId, schema.items.id), columns: { itemName: schema.items.itemName } },
    // Parent item name is searchable too, which is why the join is on the count query as well.
    searchColumns: [schema.subItems.productName, schema.items.itemName],
    defaultSort: schema.subItems.updatedAt,
    filter: (_req, q) => [
      q.itemId ? eq(schema.subItems.itemId, q.itemId) : undefined,
      q.isActive === 'true' ? eq(schema.subItems.isActive, true) : q.isActive === 'false' ? eq(schema.subItems.isActive, false) : undefined,
    ],
    shape,
    toRow: (body) => ({
      ...body,
      // zod already trimmed and capped the decimals; store at the column's fixed scale.
      ...(body.rate === undefined ? {} : { rate: Number(body.rate).toFixed(2) }),
    }),
    beforeSave: async (body, req, existing) => {
      /**
       * The parent must exist inside the caller's tenant. The composite foreign key
       * (item_id, tenant_id) already makes a cross-tenant parent impossible, so this only
       * turns a database error into a message the form can attach to the right field.
       */
      if (body.itemId) {
        const [item] = await db
          .select({ id: schema.items.id })
          .from(schema.items)
          .where(and(eq(schema.items.id, body.itemId), eq(schema.items.tenantId, req.user.tenantId)))
          .limit(1);
        if (!item) throw validation('Select a valid item', [{ path: ['itemId'], message: 'This item does not exist' }]);
      }

      /**
       * Friendly duplicate message. `sub_items_item_product_lower_idx` is the real guard — a
       * race that slips past this check still fails at the database and surfaces as a 409.
       * An update that touches neither field keeps its own name, hence the `ne(id)`.
       */
      const itemId = body.itemId ?? existing?.itemId;
      const productName = body.productName ?? existing?.productName;
      if (!itemId || !productName) return;
      const [clash] = await db
        .select({ id: schema.subItems.id })
        .from(schema.subItems)
        .where(
          and(
            eq(schema.subItems.tenantId, req.user.tenantId),
            eq(schema.subItems.itemId, itemId),
            sql`lower(${schema.subItems.productName}) = lower(${productName})`,
            existing ? ne(schema.subItems.id, existing.id) : undefined,
          ),
        )
        .limit(1);
      if (clash) throw validation(`"${productName}" already exists under this item`, [{ path: ['productName'], message: 'This product already exists under the selected item' }]);
    },
  });
}
