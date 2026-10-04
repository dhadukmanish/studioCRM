import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import {
  DEFAULT_TIME_ZONE,
  deriveSubscriptionAccess,
  nextPeriod,
  planAmount,
  planDays,
  todayInTimeZone,
  type CreateStudioInput,
  type GrantSubscriptionInput,
  type PlanKind,
  type SubscriptionAccess,
} from '@erp/shared';
import { db, schema, type Db } from '../db/client';
import { AppError, notFound, validation } from '../lib/errors';
import { seedTenantDefaults } from './tenant-setup';

/*
 * Studio subscriptions (docs/SUBSCRIPTIONS.md). A studio's expiry is DERIVED from its ACTIVE
 * periods — never stored — and `deriveSubscriptionAccess` (shared) is the only status rule.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const ts = schema.tenantSubscriptions;

/** The platform's business date. Subscription days are counted in India time. */
export const platformToday = () => todayInTimeZone(DEFAULT_TIME_ZONE);

/** Latest ACTIVE period end per tenant, plus whether the studio ever had a period. */
const latestPeriods = (tenantIds?: string[]) =>
  db
    .select({
      tenantId: ts.tenantId,
      managed: sql<boolean>`true`,
      endsOn: sql<string | null>`max(${ts.endsOn}) FILTER (WHERE ${ts.status} = 'ACTIVE')`,
      // Kind of the ACTIVE period that ends last (ties → the later grant).
      lastKind: sql<string | null>`(array_agg(${ts.kind} ORDER BY ${ts.endsOn} DESC, ${ts.createdAt} DESC) FILTER (WHERE ${ts.status} = 'ACTIVE'))[1]`,
    })
    .from(ts)
    .where(tenantIds ? inArray(ts.tenantId, tenantIds) : undefined)
    .groupBy(ts.tenantId);

export type TenantAccess = SubscriptionAccess & { planName: string | null };

/** Called on every studio request — one indexed query (tenant + its periods aggregated). */
export async function getTenantAccess(tenantId: string, today = platformToday()): Promise<TenantAccess> {
  const latest = (col: typeof ts.kind | typeof ts.planName) => sql<string | null>`(array_agg(${col} ORDER BY ${ts.endsOn} DESC, ${ts.createdAt} DESC) FILTER (WHERE ${ts.status} = 'ACTIVE'))[1]`;
  const [row] = await db
    .select({
      isActive: schema.tenants.isActive,
      managed: sql<boolean>`count(${ts.id}) > 0`,
      endsOn: sql<string | null>`max(${ts.endsOn}) FILTER (WHERE ${ts.status} = 'ACTIVE')`,
      lastKind: latest(ts.kind),
      planName: latest(ts.planName),
    })
    .from(schema.tenants)
    .leftJoin(ts, eq(ts.tenantId, schema.tenants.id))
    .where(eq(schema.tenants.id, tenantId))
    .groupBy(schema.tenants.id);
  if (!row) return { ...deriveSubscriptionAccess({ isActive: false, managed: false, endsOn: null, isTrial: false, today }), planName: null };
  return {
    ...deriveSubscriptionAccess({ isActive: row.isActive, managed: row.managed, endsOn: row.endsOn, isTrial: row.lastKind === 'TRIAL', today }),
    planName: row.planName,
  };
}

/* ------------------------------------------------------------------ studios -- */

export async function listStudios(opts: { search?: string; id?: string } = {}) {
  const today = platformToday();
  const t = schema.tenants;
  const s = opts.search?.trim();
  const tenants = await db
    .select({ id: t.id, name: t.name, slug: t.slug, isActive: t.isActive, createdAt: t.createdAt })
    .from(t)
    .where(opts.id ? eq(t.id, opts.id) : s ? or(ilike(t.name, `%${s}%`), ilike(t.slug, `%${s}%`)) : undefined)
    .orderBy(desc(t.createdAt));
  if (!tenants.length) return [];
  const ids = tenants.map((x) => x.id);
  const [periods, owners, users] = await Promise.all([
    latestPeriods(ids),
    ownersOf(ids),
    db.select({ tenantId: schema.users.tenantId, n: sql<number>`count(*)::int` }).from(schema.users).where(inArray(schema.users.tenantId, ids)).groupBy(schema.users.tenantId),
  ]);
  const byTenant = new Map(periods.map((p) => [p.tenantId, p]));
  const userCount = new Map(users.map((u) => [u.tenantId, u.n]));
  return tenants.map((x) => {
    const p = byTenant.get(x.id);
    return {
      ...x,
      owner: owners.get(x.id) ?? null,
      userCount: userCount.get(x.id) ?? 0,
      access: deriveSubscriptionAccess({ isActive: x.isActive, managed: !!p, endsOn: p?.endsOn ?? null, isTrial: p?.lastKind === 'TRIAL', today }),
    };
  });
}

/** The first Super Admin of each studio — the owner the platform deals with. */
async function ownersOf(tenantIds: string[]) {
  const rows = await db
    .select({ tenantId: schema.users.tenantId, id: schema.users.id, firstName: schema.users.firstName, lastName: schema.users.lastName, email: schema.users.email, mobile: schema.users.mobile, lastLoginAt: schema.users.lastLoginAt })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(and(inArray(schema.users.tenantId, tenantIds), eq(schema.roles.key, 'super_admin')))
    .orderBy(schema.users.createdAt);
  const map = new Map<string, { id: string; name: string; email: string; mobile: string | null; lastLoginAt: Date | null }>();
  for (const r of rows) if (!map.has(r.tenantId)) map.set(r.tenantId, { id: r.id, name: `${r.firstName} ${r.lastName}`.trim(), email: r.email, mobile: r.mobile, lastLoginAt: r.lastLoginAt });
  return map;
}

export async function getStudio(tenantId: string) {
  const [studio] = await listStudios({ id: tenantId });
  if (!studio) throw notFound('Studio');
  const periods = await db.select().from(ts).where(eq(ts.tenantId, tenantId)).orderBy(desc(ts.startsOn), desc(ts.createdAt));
  return { ...studio, periods };
}

/**
 * Sign-in looks a user up by email or username across every studio, so both must be unique
 * platform-wide — otherwise one studio's user could shadow another's.
 */
export async function assertLoginIdentityFree(tx: Tx, ident: { email?: string | null; username?: string | null }, exceptUserId?: string) {
  // Sign-in matches the typed value against BOTH columns, so each value is checked against both.
  const values = [...new Set([ident.email, ident.username].filter((v): v is string => !!v).map((v) => v.trim().toLowerCase()))].sort();
  for (const v of values) {
    // Serialise concurrent claims of the same identity (a double-click, two studios at once) until commit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'login:' + v}))`);
    const rows = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(or(sql`lower(${schema.users.email}) = ${v}`, sql`lower(${schema.users.username}) = ${v}`));
    if (rows.some((r) => r.id !== exceptUserId)) throw validation(v === ident.email?.trim().toLowerCase() ? 'This email is already used by another account' : 'This username is already used by another account');
  }
}

const slugify = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'studio'}-${randomBytes(3).toString('hex')}`;

/** A new studio: tenant, defaults, its owner (Super Admin) and the first period — all or nothing. */
export async function createStudio(input: CreateStudioInput, adminId: string) {
  const passwordHash = await bcrypt.hash(input.ownerPassword, 10);
  return db.transaction(async (tx) => {
    await assertLoginIdentityFree(tx, { email: input.ownerEmail });
    const [tenant] = await tx.insert(schema.tenants).values({ name: input.studioName, slug: slugify(input.studioName) }).returning();
    const { roles, company, branch } = await seedTenantDefaults(tx as unknown as Db, tenant.id, { companyName: input.studioName });
    await tx.insert(schema.users).values({
      tenantId: tenant.id,
      roleId: roles.super_admin.id,
      firstName: input.ownerFirstName,
      lastName: input.ownerLastName,
      email: input.ownerEmail,
      mobile: input.ownerMobile,
      passwordHash,
      companyIds: [company.id],
      branchIds: [branch.id],
    });
    await grantInTx(tx, tenant.id, input.subscription, adminId);
    return tenant;
  });
}

/* ---------------------------------------------------------------- periods -- */

export function grantSubscription(tenantId: string, input: GrantSubscriptionInput, adminId: string) {
  return db.transaction((tx) => grantInTx(tx, tenantId, input, adminId));
}

async function grantInTx(tx: Tx, tenantId: string, input: GrantSubscriptionInput, adminId: string) {
  // Serialise grants per studio, so two renewals can never both start the day after the same end.
  const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).for('update');
  if (!tenant) throw notFound('Studio');
  const [plan] = await tx.select().from(schema.subscriptionPlans).where(eq(schema.subscriptionPlans.id, input.planId));
  if (!plan) throw validation('Choose a plan');
  if (!plan.isActive) throw validation(`The plan "${plan.name}" is inactive`);
  const kind = plan.kind as PlanKind;
  const days = planDays({ kind, durationDays: plan.durationDays }, input.days);
  if (!days) throw validation('Enter the number of days', { days: 'Enter the number of days' });

  if (kind === 'TRIAL') {
    const [trial] = await tx.select({ id: ts.id }).from(ts).where(and(eq(ts.tenantId, tenantId), eq(ts.kind, 'TRIAL'), eq(ts.status, 'ACTIVE'))).limit(1);
    if (trial) throw new AppError('SUB_002', 'This studio has already had its trial', 409);
  }
  const [cur] = await tx.select({ endsOn: sql<string | null>`max(${ts.endsOn})` }).from(ts).where(and(eq(ts.tenantId, tenantId), eq(ts.status, 'ACTIVE')));
  const { startsOn, endsOn } = nextPeriod(cur?.endsOn ?? null, platformToday(), days);
  const amount = kind === 'TRIAL' ? '0.00' : input.amount ?? planAmount({ kind, price: plan.price }, days);
  if (Number(amount) > 9_999_999_999.99) throw validation('The amount is too large', { amount: 'The amount is too large' });
  const paid = Number(amount) > 0;
  if (paid && !input.paymentMode) throw validation('Choose how the payment was received', { paymentMode: 'Choose how the payment was received' });

  const [row] = await tx
    .insert(ts)
    .values({
      tenantId,
      planId: plan.id,
      planName: plan.name,
      kind,
      days,
      startsOn,
      endsOn,
      amount,
      paymentMode: paid ? input.paymentMode ?? null : null,
      paymentRef: paid ? input.paymentRef ?? null : null,
      paidOn: paid ? input.paidOn ?? platformToday() : null,
      notes: input.notes ?? null,
      createdBy: adminId,
    })
    .returning();
  return row;
}

/** A mistaken grant is cancelled, never deleted; the studio's expiry falls back to its other periods. */
export async function cancelSubscription(tenantId: string, periodId: string, reason: string, adminId: string) {
  return db.transaction(async (tx) => {
    await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).for('update');
    const [period] = await tx.select().from(ts).where(and(eq(ts.id, periodId), eq(ts.tenantId, tenantId), eq(ts.status, 'ACTIVE')));
    if (!period) throw notFound('Active subscription period');
    // Periods chain end to end, so cancelling an earlier one would leave the expiry where it was —
    // the studio would keep the days it never paid for. Only the latest can be cancelled.
    const [later] = await tx.select({ id: ts.id }).from(ts).where(and(eq(ts.tenantId, tenantId), eq(ts.status, 'ACTIVE'), sql`${ts.endsOn} > ${period.endsOn}`)).limit(1);
    if (later) throw new AppError('SUB_004', 'A later period exists — cancel the latest period first', 409);
    const [row] = await tx.update(ts).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: adminId, cancelReason: reason }).where(eq(ts.id, periodId)).returning();
    return row;
  });
}

/** Suspending ends every session of the studio at once — its refresh tokens go too. */
export async function setStudioActive(tenantId: string, isActive: boolean) {
  return db.transaction(async (tx) => {
    const [t] = await tx.update(schema.tenants).set({ isActive, updatedAt: new Date() }).where(eq(schema.tenants.id, tenantId)).returning();
    if (!t) throw notFound('Studio');
    if (!isActive) {
      const userIds = tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.tenantId, tenantId));
      await tx.delete(schema.refreshTokens).where(inArray(schema.refreshTokens.userId, userIds));
    }
    return t;
  });
}

export async function resetOwnerPassword(tenantId: string, password: string) {
  const owner = (await ownersOf([tenantId])).get(tenantId);
  if (!owner) throw notFound('Studio owner');
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ passwordHash: await bcrypt.hash(password, 10), updatedAt: new Date() }).where(eq(schema.users.id, owner.id));
    await tx.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, owner.id));
  });
  return owner;
}

/** Panel header figures. Revenue = amounts of ACTIVE periods paid this month. */
export async function platformSummary() {
  const today = platformToday();
  const studios = await listStudios();
  const count = (st: string) => studios.filter((x) => x.access.status === st).length;
  const [rev] = await db
    .select({ month: sql<string>`coalesce(sum(${ts.amount}), 0)::text` })
    .from(ts)
    .where(and(eq(ts.status, 'ACTIVE'), sql`${ts.paidOn} >= date_trunc('month', ${today}::date)`, sql`${ts.paidOn} <= ${today}::date`));
  return {
    today,
    total: studios.length,
    trial: count('TRIAL'),
    active: count('ACTIVE'),
    grace: count('GRACE'),
    expired: count('EXPIRED'),
    suspended: count('SUSPENDED'),
    unmanaged: count('UNMANAGED'),
    expiringSoon: studios.filter((x) => ['TRIAL', 'ACTIVE'].includes(x.access.status) && (x.access.daysLeft ?? 99) <= 7).length,
    revenueThisMonth: rev?.month ?? '0',
  };
}
