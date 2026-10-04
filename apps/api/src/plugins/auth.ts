import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { hasPermission, mergeGrants, type PermissionAction, type PermissionGrants } from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError } from '../lib/errors';
import { getTenantAccess, type TenantAccess } from '../services/subscriptions';

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
    /** `kind: 'platform'` marks a platform-panel token, which no studio route accepts (and vice versa). */
    payload: { sub: string; tenantId: string; kind?: 'platform' };
    user: AuthUser;
  }
}
declare module 'fastify' {
  interface FastifyRequest {
    /** The studio's subscription access, computed once by the gate in authenticate. */
    tenantAccess?: TenantAccess;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (subModule: string, action?: PermissionAction) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Load user + role and compute effective grants. Cached per request only — keep it cheap.
 *
 * Permissions come from the role. `permissionOverrides` is retired and can no longer be set
 * (see docs/ARCHITECTURE.md); it is still merged so rows that already carry overrides keep
 * the access they had.
 */
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

/** Writes a studio may still make once its subscription has expired: its own session and screen preferences. */
const READ_ONLY_ALLOWED = ['/api/auth/', '/api/column-preferences', '/api/filter-groups'];

/**
 * Subscription gate (docs/SUBSCRIPTIONS.md): a suspended studio can do nothing; an expired one can
 * read and print but not write. Enforced here so every studio route is covered.
 */
async function assertSubscriptionAllows(req: FastifyRequest, tenantId: string) {
  const access = await getTenantAccess(tenantId);
  req.tenantAccess = access;
  if (access.blocked) throw new AppError('SUB_003', 'This studio account is suspended. Please contact support.', 403);
  if (!access.readOnly || req.method === 'GET' || req.method === 'HEAD') return;
  const url = req.routeOptions.url ?? req.url;
  if (READ_ONLY_ALLOWED.some((p) => url.startsWith(p))) return;
  throw new AppError('SUB_001', 'Your subscription has expired — the account is read-only. Renew to continue.', 402);
}

export default fp(async (app: FastifyInstance) => {
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError('AUTH_002', 'Invalid or expired token', 401);
    }
    const payload = req.user as unknown as { sub: string; kind?: string };
    if (payload.kind === 'platform') throw new AppError('AUTH_002', 'Invalid or expired token', 401);
    const user = await loadAuthUser(payload.sub);
    if (!user) throw new AppError('AUTH_004', 'Account is inactive', 403);
    (req as any).user = user;
    await assertSubscriptionAllows(req, user.tenantId);
  });

  app.decorate('requirePermission', (subModule: string, action: PermissionAction = 'read') => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    const u = req.user as AuthUser;
    if (u.isSuperAdmin) return;
    if (!hasPermission(u.grants, subModule, action)) throw new AppError('AUTH_005', `You do not have ${action} permission for ${subModule}`, 403);
  });
});
