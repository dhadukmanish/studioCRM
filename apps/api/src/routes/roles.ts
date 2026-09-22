import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { roleSchema, PERMISSIONS, PERMISSION_ACTIONS, PERMISSION_MODULE_LABELS } from '@erp/shared';
import { parse } from '../lib/validate';
import { notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { logActivity } from '../services/activity';

export async function roleRoutes(app: FastifyInstance) {
  /** Catalog for the permission matrix UI */
  app.get('/api/admin/roles/permission-catalog', { preHandler: app.authenticate }, async () => ok({ permissions: PERMISSIONS, actions: PERMISSION_ACTIONS, modules: PERMISSION_MODULE_LABELS }));

  app.get('/api/admin/roles', { preHandler: app.requirePermission('admin_roles') }, async (req) => {
    const rows = await db
      .select({ r: schema.roles, users: count(schema.users.id) })
      .from(schema.roles)
      .leftJoin(schema.users, eq(schema.users.roleId, schema.roles.id))
      .where(eq(schema.roles.tenantId, req.user.tenantId))
      .groupBy(schema.roles.id)
      .orderBy(asc(schema.roles.isSystem), asc(schema.roles.name));
    const list = rows.map((x) => ({ ...x.r, userCount: Number(x.users) }));
    return ok({ rows: list, total: list.length, page: 1, pageSize: list.length });
  });

  app.get('/api/admin/roles/:id', { preHandler: app.requirePermission('admin_roles') }, async (req) => {
    const { id } = req.params as { id: string };
    const [r] = await db.select().from(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.tenantId, req.user.tenantId)));
    if (!r) throw notFound('Role');
    return ok(r);
  });

  app.post('/api/admin/roles', { preHandler: app.requirePermission('admin_roles', 'create') }, async (req) => {
    const body = parse(roleSchema, req.body);
    const [r] = await db.insert(schema.roles).values({ ...body, tenantId: req.user.tenantId }).returning();
    await logActivity(req, 'role', r.id, 'created', `Role "${r.name}" created`);
    return ok(r, 'Role created successfully');
  });

  app.put('/api/admin/roles/:id', { preHandler: app.requirePermission('admin_roles', 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(roleSchema.partial(), req.body);
    const [existing] = await db.select().from(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.tenantId, req.user.tenantId)));
    if (!existing) throw notFound('Role');
    if (existing.key === 'super_admin' && body.permissions) throw validation('Super Admin permissions cannot be changed');
    if (existing.isSystem && body.isActive === false) throw validation('System roles cannot be deactivated');
    const [r] = await db.update(schema.roles).set({ ...body, updatedAt: new Date() }).where(eq(schema.roles.id, id)).returning();
    await logActivity(req, 'role', r.id, 'updated', `Role "${r.name}" updated`);
    return ok(r, 'Role updated successfully');
  });

  app.delete('/api/admin/roles/:id', { preHandler: app.requirePermission('admin_roles', 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.tenantId, req.user.tenantId)));
    if (!existing) throw notFound('Role');
    if (existing.isSystem) throw validation('System roles cannot be deleted');
    const [{ n }] = await db.select({ n: count() }).from(schema.users).where(eq(schema.users.roleId, id));
    if (Number(n) > 0) throw validation(`${n} user(s) still use this role — reassign them first`);
    await db.delete(schema.roles).where(eq(schema.roles.id, id));
    await logActivity(req, 'role', id, 'deleted', `Role "${existing.name}" deleted`);
    return ok(null, 'Role deleted successfully');
  });

  /** Duplicate a role (handy starting point for custom roles). */
  app.post('/api/admin/roles/:id/clone', { preHandler: app.requirePermission('admin_roles', 'create') }, async (req) => {
    const { id } = req.params as { id: string };
    const [src] = await db.select().from(schema.roles).where(and(eq(schema.roles.id, id), eq(schema.roles.tenantId, req.user.tenantId)));
    if (!src) throw notFound('Role');
    const [r] = await db.insert(schema.roles).values({ tenantId: req.user.tenantId, name: `${src.name} (copy)`, description: src.description, permissions: src.permissions }).returning();
    return ok(r, 'Role cloned');
  });

  app.get('/api/common/lookups/roles', { preHandler: app.authenticate }, async (req) => {
    const rows = await db.select({ id: schema.roles.id, name: schema.roles.name, key: schema.roles.key, isSystem: schema.roles.isSystem }).from(schema.roles).where(and(eq(schema.roles.tenantId, req.user.tenantId), eq(schema.roles.isActive, true))).orderBy(asc(schema.roles.name));
    return ok(rows);
  });
}
