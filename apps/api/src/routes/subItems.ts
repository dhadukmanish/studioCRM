import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { subItemSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    /**
     * `bill_items` references this row with ON DELETE RESTRICT, so the database would refuse
     * anyway — but as an opaque 500. Say what is actually in the way, and name the alternative:
     * a product that has been billed is deactivated, never deleted out from under its history.
     */
    beforeDelete: async (row, req) => {
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.billItems)
        .where(and(eq(schema.billItems.tenantId, req.user.tenantId), eq(schema.billItems.subItemId, row.id)));
      if (Number(total) > 0) throw validation(`"${row.productName}" is used on ${total} bill line${Number(total) === 1 ? '' : 's'} and cannot be deleted. Set this product to Inactive instead.`);
    },
  });
  /**
   * Lookup for pickers — Billing's product column, which asks for the products of ONE item at
   * a time. A blank `itemId` returns nothing rather than every product in the tenant: the
   * grid always knows which item it is filling in, and a whole price list is not a picker's
   * business.
   *
   * Active products only, because this offers choices for a NEW line. The rate and the remark
   * come with them because they are exactly what selecting a product fills in — and both are
   * only DEFAULTS: what a bill stores is what the operator saved, snapshotted on the line.
   */
  app.get('/api/common/lookups/sub-items', { preHandler: app.authenticate }, async (req) => {
    const { itemId } = req.query as { itemId?: string };
    // A malformed id is not a lookup for anything — answering [] beats a 500 from uuid parsing.
    if (!itemId || !UUID_RE.test(itemId)) return ok([]);
    const rows = await db
      .select({ id: schema.subItems.id, itemId: schema.subItems.itemId, productName: schema.subItems.productName, rate: schema.subItems.rate, remark: schema.subItems.remark })
      .from(schema.subItems)
      .where(and(eq(schema.subItems.tenantId, req.user.tenantId), eq(schema.subItems.itemId, itemId), eq(schema.subItems.isActive, true)))
      .orderBy(asc(schema.subItems.productName));
    return ok(rows.map((r) => ({ ...r, rate: Number(r.rate) })));
  });
}
