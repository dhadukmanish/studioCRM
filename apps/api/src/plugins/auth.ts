import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { hasPermission, mergeGrants, type PermissionAction, type PermissionGrants } from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError } from '../lib/errors';

/** What every authenticated request carries on `req.user`. */
export interface AuthUser {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  roleId: string;
  roleKey: string | null;
  roleName: string;
  isSuperAdmin: boolean;
  grants: PermissionGrants;
  companyIds: string[];
  branchIds: string[];
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; tenantId: string };
    user: AuthUser;
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (subModule: string, action?: PermissionAction) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Load user + role and compute effective grants. Cached per request only — keep it cheap. */
export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const [row] = await db
    .select({ u: schema.users, r: schema.roles })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.users.id, userId));
  if (!row || !row.u.isActive) return null;
  const isSuperAdmin = row.r.key === 'super_admin';
  return {
    id: row.u.id,
    tenantId: row.u.tenantId,
    name: `${row.u.firstName} ${row.u.lastName}`.trim(),
    email: row.u.email,
    roleId: row.r.id,
    roleKey: row.r.key,
    roleName: row.r.name,
    isSuperAdmin,
    grants: isSuperAdmin ? {} : mergeGrants(row.r.isActive ? (row.r.permissions as PermissionGrants) : {}, row.u.permissionOverrides as PermissionGrants),
    companyIds: row.u.companyIds,
    branchIds: row.u.branchIds,
  };
}

export default fp(async (app: FastifyInstance) => {
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError('AUTH_002', 'Invalid or expired token', 401);
    }
    const payload = req.user as unknown as { sub: string };
    const user = await loadAuthUser(payload.sub);
    if (!user) throw new AppError('AUTH_004', 'Account is inactive', 403);
    (req as any).user = user;
  });

  app.decorate('requirePermission', (subModule: string, action: PermissionAction = 'read') => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    const u = req.user as AuthUser;
    if (u.isSuperAdmin) return;
    if (!hasPermission(u.grants, subModule, action)) throw new AppError('AUTH_005', `You do not have ${action} permission for ${subModule}`, 403);
  });
});
