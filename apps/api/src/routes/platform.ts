import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { asc, eq, sql } from 'drizzle-orm';
import {
  cancelSubscriptionSchema,
  createStudioSchema,
  grantSubscriptionSchema,
  ownerPasswordSchema,
  planSchema,
  platformChangePasswordSchema,
  platformLoginSchema,
  studioStatusSchema,
  updateStudioSchema,
} from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { AppError, notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { fixedWindowLimiter } from '../lib/rateLimit';
import {
  cancelSubscription,
  createStudio,
  getStudio,
  grantSubscription,
  listStudios,
  platformSummary,
  resetOwnerPassword,
  setStudioActive,
} from '../services/subscriptions';

/*
 * The platform panel API (docs/SUBSCRIPTIONS.md) — for the company that sells StudioCRM.
 * Its tokens carry `kind: 'platform'`: a studio token is refused here and a platform token is
 * refused by every studio route (plugins/auth.ts). Nothing here is tenant-scoped by design —
 * the platform sees every studio.
 */

const SESSION_HOURS = 12;
interface PlatformAdmin {
  id: string;
  name: string;
  email: string;
}
declare module 'fastify' {
  interface FastifyRequest {
    platformAdmin?: PlatformAdmin;
  }
}

// Sign-in attempts: 10 per email and 30 per client address per 15 minutes; a flooded limiter refuses rather than resets.
const allowLoginEmail = fixedWindowLimiter({ limit: 10, windowMs: 15 * 60_000, whenFull: 'refuse' });
const allowLoginIp = fixedWindowLimiter({ limit: 30, windowMs: 15 * 60_000, whenFull: 'refuse' });

const adminOf = (req: FastifyRequest) => req.platformAdmin as PlatformAdmin;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id is a 404, not a database error. */
const uuidOr404 = (v: string, what: string) => {
  if (!UUID.test(v)) throw notFound(what);
  return v;
};
const idParam = (req: FastifyRequest, what = 'Studio') => uuidOr404((req.params as { id: string }).id, what);

export async function platformRoutes(app: FastifyInstance) {
  async function requirePlatformAdmin(req: FastifyRequest) {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError('AUTH_002', 'Invalid or expired token', 401);
    }
    const payload = req.user as unknown as { sub: string; kind?: string };
    if (payload.kind !== 'platform') throw new AppError('AUTH_002', 'Invalid or expired token', 401);
    const [a] = await db.select().from(schema.platformAdmins).where(eq(schema.platformAdmins.id, payload.sub));
    if (!a || !a.isActive) throw new AppError('AUTH_004', 'Account is inactive', 403);
    req.platformAdmin = { id: a.id, name: a.name, email: a.email };
  }
  const guarded = { preHandler: requirePlatformAdmin };

  /* ---------------------------------------------------------------- auth -- */

  app.post('/api/platform/auth/login', async (req) => {
    const body = parse(platformLoginSchema, req.body);
    const email = body.email.toLowerCase();
    if (!allowLoginIp(req.ip) || !allowLoginEmail(email)) throw new AppError('AUTH_006', 'Too many sign-in attempts. Try again in 15 minutes.', 429);
    const [a] = await db.select().from(schema.platformAdmins).where(eq(schema.platformAdmins.email, email));
    if (!a || !(await bcrypt.compare(body.password, a.passwordHash))) throw new AppError('AUTH_001', 'Invalid email or password', 401);
    if (!a.isActive) throw new AppError('AUTH_004', 'This account is inactive', 403);
    await db.update(schema.platformAdmins).set({ lastLoginAt: new Date() }).where(eq(schema.platformAdmins.id, a.id));
    const accessToken = app.jwt.sign({ sub: a.id, tenantId: '', kind: 'platform' }, { expiresIn: `${SESSION_HOURS}h` });
    return ok({ accessToken, admin: { id: a.id, name: a.name, email: a.email } }, 'Login successful');
  });

  app.get('/api/platform/auth/me', guarded, async (req) => ok(adminOf(req)));

  app.put('/api/platform/auth/change-password', guarded, async (req) => {
    const body = parse(platformChangePasswordSchema, req.body);
    const [a] = await db.select().from(schema.platformAdmins).where(eq(schema.platformAdmins.id, adminOf(req).id));
    if (!a || !(await bcrypt.compare(body.currentPassword, a.passwordHash))) throw validation('Current password is incorrect');
    await db.update(schema.platformAdmins).set({ passwordHash: await bcrypt.hash(body.newPassword, 10), updatedAt: new Date() }).where(eq(schema.platformAdmins.id, a.id));
    return ok(null, 'Password changed');
  });

  /* ------------------------------------------------------------- summary -- */

  app.get('/api/platform/summary', guarded, async () => ok(await platformSummary()));

  /* --------------------------------------------------------------- plans -- */

  const plans = schema.subscriptionPlans;
  /** `usedCount` = periods ever granted on the plan (cancelled included); an unused plan can be deleted. */
  // Written out with table names: inside a correlated subquery Drizzle would leave the columns unqualified.
  const periodsOn = sql<number>`(select count(*)::int from tenant_subscriptions ts where ts.plan_id = subscription_plans.id)`;
  app.get('/api/platform/plans', guarded, async () => ok(await db.select({ plan: plans, usedCount: periodsOn }).from(plans).orderBy(asc(plans.sortOrder), asc(plans.name)).then((rows) => rows.map((r) => ({ ...r.plan, usedCount: r.usedCount })))));

  app.post('/api/platform/plans', guarded, async (req) => {
    const body = parse(planSchema, req.body);
    await assertPlanNameFree(body.name);
    const [p] = await db.insert(plans).values(body).returning();
    return ok(p, 'Plan created');
  });

  app.put('/api/platform/plans/:id', guarded, async (req) => {
    const id = idParam(req, 'Plan');
    const body = parse(planSchema, req.body);
    const [cur] = await db.select().from(plans).where(eq(plans.id, id));
    if (!cur) throw notFound('Plan');
    // Granted periods snapshot the kind; changing it would make the plan mean something else.
    if (cur.kind !== body.kind) throw validation('A plan’s type cannot be changed — create a new plan instead');
    await assertPlanNameFree(body.name, id);
    const [p] = await db.update(plans).set({ ...body, updatedAt: new Date() }).where(eq(plans.id, id)).returning();
    return ok(p, 'Plan updated');
  });

  /** Only a plan nobody was ever granted — history keeps the plan it was sold on; deactivate it instead. */
  app.delete('/api/platform/plans/:id', guarded, async (req) => {
    const id = idParam(req, 'Plan');
    const [x] = await db.select({ id: plans.id, usedCount: periodsOn }).from(plans).where(eq(plans.id, id));
    if (!x) throw notFound('Plan');
    if (x.usedCount > 0) throw new AppError('SUB_005', 'This plan has been granted to studios — make it inactive instead of deleting it', 409);
    await db.delete(plans).where(eq(plans.id, id));
    return ok(null, 'Plan deleted');
  });

  async function assertPlanNameFree(name: string, exceptId?: string) {
    const [x] = await db.select({ id: plans.id }).from(plans).where(eq(plans.name, name));
    if (x && x.id !== exceptId) throw validation('A plan with this name already exists', { name: 'A plan with this name already exists' });
  }

  /* ------------------------------------------------------------- studios -- */

  app.get('/api/platform/studios', guarded, async (req) => {
    const { search } = req.query as { search?: string };
    return ok(await listStudios({ search }));
  });

  app.post('/api/platform/studios', guarded, async (req) => {
    const body = parse(createStudioSchema, req.body);
    const tenant = await createStudio(body, adminOf(req).id);
    return ok(await getStudio(tenant.id), 'Studio created');
  });

  app.get('/api/platform/studios/:id', guarded, async (req) => ok(await getStudio(idParam(req))));

  app.put('/api/platform/studios/:id', guarded, async (req) => {
    const body = parse(updateStudioSchema, req.body);
    const [t] = await db.update(schema.tenants).set({ name: body.name, updatedAt: new Date() }).where(eq(schema.tenants.id, idParam(req))).returning();
    if (!t) throw notFound('Studio');
    return ok(await getStudio(t.id), 'Studio updated');
  });

  app.post('/api/platform/studios/:id/status', guarded, async (req) => {
    const body = parse(studioStatusSchema, req.body);
    await setStudioActive(idParam(req), body.isActive);
    return ok(await getStudio(idParam(req)), body.isActive ? 'Studio activated' : 'Studio suspended');
  });

  app.post('/api/platform/studios/:id/owner-password', guarded, async (req) => {
    const body = parse(ownerPasswordSchema, req.body);
    const owner = await resetOwnerPassword(idParam(req), body.password);
    return ok(null, `Password reset for ${owner.email}`);
  });

  app.post('/api/platform/studios/:id/subscriptions', guarded, async (req) => {
    const body = parse(grantSubscriptionSchema, req.body);
    await grantSubscription(idParam(req), body, adminOf(req).id);
    return ok(await getStudio(idParam(req)), 'Subscription added');
  });

  app.post('/api/platform/studios/:id/subscriptions/:sid/cancel', guarded, async (req) => {
    const id = idParam(req);
    const sid = uuidOr404((req.params as { sid: string }).sid, 'Subscription period');
    const body = parse(cancelSubscriptionSchema, req.body);
    await cancelSubscription(id, sid, body.reason, adminOf(req).id);
    return ok(await getStudio(id), 'Subscription period cancelled');
  });
}
