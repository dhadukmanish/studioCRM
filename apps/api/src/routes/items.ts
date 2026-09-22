import type { FastifyInstance } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { itemSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';

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
  });
}
