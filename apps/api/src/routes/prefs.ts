import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { ok } from '../lib/respond';

export async function prefRoutes(app: FastifyInstance) {
  app.get('/api/column-preferences', { preHandler: app.authenticate }, async (req) => {
    const { moduleName } = req.query as { moduleName: string };
    const [row] = await db.select().from(schema.listPreferences).where(and(eq(schema.listPreferences.userId, req.user.id), eq(schema.listPreferences.moduleName, moduleName)));
    return ok(row?.columns ?? []);
  });
  app.put('/api/column-preferences', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ moduleName: z.string(), columns: z.array(z.object({ key: z.string(), visible: z.boolean() })) }).parse(req.body);
    await db
      .insert(schema.listPreferences)
      .values({ tenantId: req.user.tenantId, userId: req.user.id, moduleName: body.moduleName, columns: body.columns })
      .onConflictDoUpdate({ target: [schema.listPreferences.userId, schema.listPreferences.moduleName], set: { columns: body.columns, updatedAt: new Date() } });
    return ok(body.columns, 'Column preferences saved');
  });
  app.get('/api/filter-groups', { preHandler: app.authenticate }, async (req) => {
    const { moduleName } = req.query as { moduleName: string };
    const [row] = await db.select().from(schema.listPreferences).where(and(eq(schema.listPreferences.userId, req.user.id), eq(schema.listPreferences.moduleName, moduleName)));
    return ok(row?.filterGroups ?? []);
  });
  app.put('/api/filter-groups', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ moduleName: z.string(), filterGroups: z.array(z.any()) }).parse(req.body);
    await db
      .insert(schema.listPreferences)
      .values({ tenantId: req.user.tenantId, userId: req.user.id, moduleName: body.moduleName, filterGroups: body.filterGroups })
      .onConflictDoUpdate({ target: [schema.listPreferences.userId, schema.listPreferences.moduleName], set: { filterGroups: body.filterGroups, updatedAt: new Date() } });
    return ok(body.filterGroups, 'Filters saved');
  });
  /** Activity log — per entity, or the whole tenant feed (paginated). */
  app.get('/api/activity-logs', { preHandler: app.authenticate }, async (req) => {
    const { entityType, entityId, page = '1', limit = '50', search } = req.query as Record<string, string | undefined>;
    if (!entityType && !req.user.isSuperAdmin && !req.user.grants.admin_activity_logs?.includes('read')) return ok({ rows: [], total: 0, page: 1, pageSize: 0 });
    const where = and(
      eq(schema.activityLogs.tenantId, req.user.tenantId),
      entityType ? eq(schema.activityLogs.entityType, entityType) : undefined,
      entityId ? eq(schema.activityLogs.entityId, entityId) : undefined,
      search ? ilike(schema.activityLogs.description, `%${search}%`) : undefined,
    );
    const p = Math.max(1, Number(page) || 1), l = Math.min(200, Number(limit) || 50);
    const [{ total }] = await db.select({ total: count() }).from(schema.activityLogs).where(where);
    const rows = await db
      .select({ a: schema.activityLogs, userName: schema.users.firstName, userLast: schema.users.lastName })
      .from(schema.activityLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.activityLogs.userId))
      .where(where)
      .orderBy(desc(schema.activityLogs.createdAt))
      .limit(l)
      .offset((p - 1) * l);
    return ok({ rows: rows.map((r) => ({ ...r.a, userName: r.userName ? `${r.userName} ${r.userLast ?? ''}`.trim() : (r.a.meta as any)?.userName ?? 'System' })), total: Number(total), page: p, pageSize: l });
  });
}
