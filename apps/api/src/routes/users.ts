import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { userSchema } from '@erp/shared';
import { parse } from '../lib/validate';
import { notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, tableColumns } from '../lib/filters';
import { logActivity } from '../services/activity';

export function publicUser(u: typeof schema.users.$inferSelect & { roleName?: string; roleKey?: string | null }) {
  const { passwordHash: _p, ...rest } = u;
  return { ...rest, name: `${u.firstName} ${u.lastName}`.trim() };
}

export async function userRoutes(app: FastifyInstance) {
  const COLS = { ...tableColumns(schema.users), roleName: schema.roles.name };

  app.get('/api/admin/users', { preHandler: app.requirePermission('admin_users') }, async (req) => {
    const q = parseListQuery(req.query as any);
    const { isActive, roleId } = req.query as { isActive?: string; roleId?: string };
    const where = and(
      eq(schema.users.tenantId, req.user.tenantId),
      isActive === 'true' ? eq(schema.users.isActive, true) : isActive === 'false' ? eq(schema.users.isActive, false) : undefined,
      roleId ? eq(schema.users.roleId, roleId) : undefined,
      filterWhere((req.query as any).filters, COLS),
      q.search ? or(ilike(schema.users.firstName, `%${q.search}%`), ilike(schema.users.lastName, `%${q.search}%`), ilike(schema.users.email, `%${q.search}%`), ilike(schema.users.mobile, `%${q.search}%`)) : undefined,
    );
    const base = db.select({ u: schema.users, roleName: schema.roles.name, roleKey: schema.roles.key }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId));
    const [{ total }] = await db.select({ total: count() }).from(schema.users).innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId)).where(where);
    const rows = await base.where(where).orderBy(sortBy(q.sortBy, q.sortOrder, COLS, schema.users.createdAt)).limit(q.limit).offset((q.page - 1) * q.limit);
    return ok({ rows: rows.map((r) => publicUser({ ...r.u, roleName: r.roleName, roleKey: r.roleKey })), total: Number(total), page: q.page, pageSize: q.limit }, 'Users retrieved successfully');
  });

  app.get('/api/admin/users/:id', { preHandler: app.requirePermission('admin_users') }, async (req) => {
    const { id } = req.params as { id: string };
    const [u] = await db.select().from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.tenantId, req.user.tenantId)));
    if (!u) throw notFound('User');
    return ok(publicUser(u));
  });

  app.post('/api/admin/users', { preHandler: app.requirePermission('admin_users', 'create') }, async (req) => {
    const body = parse(userSchema, req.body);
    if (!body.password) throw validation('Password is required');
    await assertRole(req.user.tenantId, body.roleId, req.user.isSuperAdmin);
    const { password, ...rest } = body;
    const [u] = await db.insert(schema.users).values({ ...rest, username: rest.username || null, email: rest.email.toLowerCase(), tenantId: req.user.tenantId, passwordHash: await bcrypt.hash(password, 10) }).returning();
    await logActivity(req, 'user', u.id, 'created', `User "${u.email}" created`);
    return ok(publicUser(u), 'User created successfully');
  });

  app.put('/api/admin/users/:id', { preHandler: app.requirePermission('admin_users', 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(userSchema.partial(), req.body);
    if (body.roleId) await assertRole(req.user.tenantId, body.roleId, req.user.isSuperAdmin);
    const { password, ...rest } = body;
    const patch: any = { ...rest, updatedAt: new Date() };
    if (rest.email) patch.email = rest.email.toLowerCase();
    if (rest.username !== undefined) patch.username = rest.username || null;
    if (password) patch.passwordHash = await bcrypt.hash(password, 10);
    if (id === req.user.id && body.isActive === false) throw validation('You cannot deactivate your own account');
    const [u] = await db.update(schema.users).set(patch).where(and(eq(schema.users.id, id), eq(schema.users.tenantId, req.user.tenantId))).returning();
    if (!u) throw notFound('User');
    await logActivity(req, 'user', u.id, 'updated', `User "${u.email}" updated`);
    return ok(publicUser(u), 'User updated successfully');
  });

  app.delete('/api/admin/users/:id', { preHandler: app.requirePermission('admin_users', 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    if (id === req.user.id) throw validation('You cannot delete your own account');
    const r = await db.delete(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.tenantId, req.user.tenantId))).returning({ id: schema.users.id, email: schema.users.email });
    if (!r.length) throw notFound('User');
    await logActivity(req, 'user', id, 'deleted', `User "${r[0].email}" deleted`);
    return ok(null, 'User deleted successfully');
  });

  app.get('/api/common/lookups/users', { preHandler: app.authenticate }, async (req) => {
    const rows = await db.select({ id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email }).from(schema.users).where(and(eq(schema.users.tenantId, req.user.tenantId), eq(schema.users.isActive, true))).orderBy(asc(schema.users.firstName));
    return ok(rows.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email })));
  });
}

/** Only a super admin may assign the super_admin role. */
async function assertRole(tenantId: string, roleId: string, isSuperAdmin: boolean) {
  const [r] = await db.select().from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.tenantId, tenantId)));
  if (!r) throw validation('Role not found');
  if (r.key === 'super_admin' && !isSuperAdmin) throw validation('Only a Super Admin can assign the Super Admin role');
}
