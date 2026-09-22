import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ZodSchema } from 'zod';
import { db } from '../db/client';
import { parse } from './validate';
import { notFound, validation } from './errors';
import { ok } from './respond';
import { parseListQuery } from './list';
import { filterWhere, sortBy, tableColumns, type ColumnMap } from './filters';
import { logActivity } from '../services/activity';

type AnyTable = PgTable & { id: PgColumn; tenantId: PgColumn; createdAt: PgColumn };

export interface CrudOptions<T extends AnyTable> {
  table: T;
  base: string; // e.g. /api/accounting/masters/units
  permission: string; // sub-module key
  schema: ZodSchema<any>;
  label: string; // "Unit"
  searchColumns?: PgColumn[];
  defaultSort?: PgColumn;
  sortable?: Record<string, PgColumn>;
  /**
   * Left join applied to the list query only, so a list can carry a parent's display name
   * without a query per row. `columns` are added to the selected row, and become searchable,
   * sortable and filterable like the table's own columns.
   */
  join?: { table: PgTable; on: SQL; columns: ColumnMap };
  /** extra WHERE from query (filters) */
  filter?: (req: FastifyRequest, q: Record<string, any>) => (SQL | undefined)[];
  /** transform validated body → row (both create and update) */
  toRow?: (body: any, req: FastifyRequest, existing?: any) => Record<string, any>;
  /** hook after create/update — e.g. to clear other defaults */
  beforeSave?: (body: any, req: FastifyRequest, existing?: any) => Promise<void>;
  /** guard deletion of system rows */
  protectSystem?: boolean;
  /** list without pagination (all rows) */
  listAll?: boolean;
  /** decorate rows for output */
  shape?: (row: any) => any;
  afterCreate?: (row: any, req: FastifyRequest) => Promise<void>;
  afterUpdate?: (row: any, req: FastifyRequest, previous: any) => Promise<void>;
  beforeDelete?: (row: any, req: FastifyRequest) => Promise<void>;
  /** write an activity log entry on create/update/delete (default true) */
  audit?: boolean;
  /** which field names the audit description (default `name`) */
  labelField?: string;
}

/** Registers list/get/create/update/delete for a tenant-scoped master table. */
export function crudRoutes<T extends AnyTable>(app: FastifyInstance, o: CrudOptions<T>) {
  const t = o.table as any;
  const shape = o.shape ?? ((r: any) => r);
  const cols = { ...tableColumns(t), ...(o.join?.columns ?? {}), ...(o.sortable ?? {}) };
  /** One place that knows about the optional join, so count and rows can never disagree. */
  const from = (fields?: ColumnMap) => {
    const q: any = fields ? db.select(fields as any).from(t) : db.select().from(t);
    return o.join ? q.leftJoin(o.join.table, o.join.on) : q;
  };
  const listFields = o.join ? { ...tableColumns(t), ...o.join.columns } : undefined;

  app.get(o.base, { preHandler: app.requirePermission(o.permission) }, async (req) => {
    const q = parseListQuery(req.query as any);
    const where = and(
      eq(t.tenantId, req.user.tenantId),
      q.search && o.searchColumns?.length ? or(...o.searchColumns.map((c) => ilike(c, `%${q.search}%`))) : undefined,
      filterWhere((req.query as any).filters, cols),
      ...(o.filter ? o.filter(req, req.query as any) : []),
    );
    const order = sortBy(q.sortBy, q.sortOrder, cols, o.defaultSort || t.createdAt);
    if (o.listAll) {
      const rows = await from(listFields).where(where).orderBy(order);
      return ok({ rows: rows.map(shape), total: rows.length, page: 1, pageSize: rows.length }, `${o.label}s retrieved successfully`);
    }
    const [{ total }] = await from({ total: count() as any }).where(where);
    const rows = await from(listFields).where(where).orderBy(order).limit(q.limit).offset((q.page - 1) * q.limit);
    return ok({ rows: rows.map(shape), total: Number(total), page: q.page, pageSize: q.limit }, `${o.label}s retrieved successfully`);
  });

  app.get(`${o.base}/:id`, { preHandler: app.requirePermission(o.permission) }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, req.user.tenantId)));
    if (!row) throw notFound(o.label);
    return ok(shape(row));
  });

  app.post(o.base, { preHandler: app.requirePermission(o.permission, 'create') }, async (req) => {
    const body = parse(o.schema, req.body);
    await o.beforeSave?.(body, req);
    const row: Record<string, any> = o.toRow ? o.toRow(body, req) : body;
    const [created] = await db.insert(t).values({ ...row, tenantId: req.user.tenantId }).returning();
    await o.afterCreate?.(created, req);
    if (o.audit !== false) await logActivity(req, o.label.toLowerCase(), created.id, 'created', `${o.label} "${created[o.labelField ?? 'name'] ?? ''}" created`);
    return ok(shape(created), `${o.label} created successfully`);
  });

  app.put(`${o.base}/:id`, { preHandler: app.requirePermission(o.permission, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, req.user.tenantId)));
    if (!existing) throw notFound(o.label);
    const partial = (o.schema as any).partial ? (o.schema as any).partial() : (o.schema as any).innerType?.().partial?.() ?? o.schema;
    const body = parse(partial, req.body) as Record<string, any>;
    await o.beforeSave?.(body, req, existing);
    const row: Record<string, any> = o.toRow ? o.toRow(body, req, existing) : body;
    const [updated] = await db.update(t).set({ ...row, updatedAt: new Date() }).where(eq(t.id, id)).returning();
    await o.afterUpdate?.(updated, req, existing);
    if (o.audit !== false) await logActivity(req, o.label.toLowerCase(), updated.id, 'updated', `${o.label} "${updated[o.labelField ?? 'name'] ?? ''}" updated`, { changed: Object.keys(row) });
    return ok(shape(updated), `${o.label} updated successfully`);
  });

  app.delete(`${o.base}/:id`, { preHandler: app.requirePermission(o.permission, 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, req.user.tenantId)));
    if (!existing) throw notFound(o.label);
    if (o.protectSystem && (existing as any).isSystem) throw validation(`System ${o.label.toLowerCase()} cannot be deleted`);
    await o.beforeDelete?.(existing, req);
    await db.delete(t).where(eq(t.id, id));
    if (o.audit !== false) await logActivity(req, o.label.toLowerCase(), id, 'deleted', `${o.label} "${(existing as any)[o.labelField ?? 'name'] ?? ''}" deleted`);
    return ok(null, `${o.label} deleted successfully`);
  });
}
