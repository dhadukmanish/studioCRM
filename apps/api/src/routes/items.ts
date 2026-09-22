import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { itemSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';

/** API shape: gstRate is numeric in Postgres, which Drizzle returns as a string. */
const shape = (row: typeof schema.items.$inferSelect) => ({ ...row, gstRate: Number(row.gstRate) });

/**
 * Item Master — what the studio sells or produces. List/search/filter/sort/paginate,
 * create, update and delete come from the CRUD factory, which also enforces the
 * permission and the tenant predicate on every query.
 */
export async function itemRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.items,
    base: '/api/masters/items',
    permission: 'masters_items',
    schema: itemSchema,
    label: 'Item',
    labelField: 'itemName',
    searchColumns: [schema.items.itemName, schema.items.hsnCode],
    defaultSort: schema.items.updatedAt,
    filter: (_req, q) => [q.isActive === 'true' ? eq(schema.items.isActive, true) : q.isActive === 'false' ? eq(schema.items.isActive, false) : undefined],
    shape,
    toRow: (body) => ({
      ...body,
      // zod already trimmed; gstRate is stored at the column's fixed scale.
      ...(body.gstRate === undefined ? {} : { gstRate: Number(body.gstRate).toFixed(2) }),
    }),
    /**
     * Friendly duplicate message. `items_tenant_name_lower_idx` is the real guard — a race
     * that slips past this check still fails at the database and surfaces as a 409.
     */
    beforeSave: async (body, req, existing) => {
      if (!body.itemName) return;
      const [clash] = await db
        .select({ id: schema.items.id })
        .from(schema.items)
        .where(
          and(
            eq(schema.items.tenantId, req.user.tenantId),
            sql`lower(${schema.items.itemName}) = lower(${body.itemName})`,
            existing ? ne(schema.items.id, existing.id) : undefined,
          ),
        )
        .limit(1);
      if (clash) throw validation(`An item named "${body.itemName}" already exists`, [{ path: ['itemName'], message: 'This item name is already used' }]);
    },
    /**
     * `sub_items` references this row with ON DELETE RESTRICT, so the database would refuse
     * anyway — but as an opaque 500. Say what is actually in the way instead.
     */
    beforeDelete: async (row, req) => {
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.subItems)
        .where(and(eq(schema.subItems.tenantId, req.user.tenantId), eq(schema.subItems.itemId, row.id)));
      if (Number(total) > 0) throw validation(`"${row.itemName}" still has ${total} sub item${Number(total) === 1 ? '' : 's'}. Delete those first, or set this item to Inactive instead.`);
    },
  });

  /**
   * Lookup for pickers (Sub Item Master's parent selector). Active items only — a new record
   * should not be hung off a retired item. Editing a record whose parent has since been
   * deactivated still works: the form keeps showing the parent it already has.
   */
  app.get('/api/common/lookups/items', { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({ id: schema.items.id, itemName: schema.items.itemName })
      .from(schema.items)
      .where(and(eq(schema.items.tenantId, req.user.tenantId), eq(schema.items.isActive, true)))
      .orderBy(asc(schema.items.itemName));
    return ok(rows);
  });
}
