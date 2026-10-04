import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fixedWindowLimiter } from '../lib/rateLimit';
import { addDays, createStudioSchema, deriveSubscriptionAccess, grantSubscriptionSchema, nextPeriod, planAmount, planSchema } from '@erp/shared';

/**
 * SaaS subscriptions (docs/SUBSCRIPTIONS.md).
 *
 * Section A is the pure status / period / price rules — always runs. Section B needs a THROWAWAY
 * database (TEST_DATABASE_URL): platform/studio token separation, studio creation, renewal
 * continuity, trial-once, read-only enforcement, suspension and platform-wide login uniqueness.
 */

/* ------------------------------------------------------- A. pure rules -- */

describe('deriveSubscriptionAccess', () => {
  const today = '2026-10-04';
  const derive = (o: Partial<Parameters<typeof deriveSubscriptionAccess>[0]>) => deriveSubscriptionAccess({ isActive: true, managed: true, endsOn: today, isTrial: false, today, ...o });

  it('leaves a studio that never had a period unrestricted', () => {
    expect(derive({ managed: false, endsOn: null })).toMatchObject({ status: 'UNMANAGED', readOnly: false, blocked: false, daysLeft: null });
  });
  it('counts the last paid day as a full day of access', () => {
    expect(derive({ endsOn: today })).toMatchObject({ status: 'ACTIVE', daysLeft: 1, readOnly: false });
    expect(derive({ endsOn: addDays(today, 6) })).toMatchObject({ status: 'ACTIVE', daysLeft: 7 });
  });
  it('reports a running trial as TRIAL', () => {
    expect(derive({ isTrial: true, endsOn: addDays(today, 2) })).toMatchObject({ status: 'TRIAL', daysLeft: 3 });
  });
  it('gives a paid subscription exactly 3 grace days with full access, then read-only', () => {
    expect(derive({ endsOn: addDays(today, -1) })).toMatchObject({ status: 'GRACE', readOnly: false });
    expect(derive({ endsOn: addDays(today, -3) })).toMatchObject({ status: 'GRACE', readOnly: false });
    expect(derive({ endsOn: addDays(today, -4) })).toMatchObject({ status: 'EXPIRED', readOnly: true, blocked: false });
  });
  it('gives an ended trial no grace', () => {
    expect(derive({ isTrial: true, endsOn: addDays(today, -1) })).toMatchObject({ status: 'EXPIRED', readOnly: true });
  });
  it('treats a managed studio whose periods were all cancelled as expired', () => {
    expect(derive({ endsOn: null })).toMatchObject({ status: 'EXPIRED', readOnly: true });
  });
  it('blocks a suspended studio whatever its periods say', () => {
    expect(derive({ isActive: false, endsOn: addDays(today, 100) })).toMatchObject({ status: 'SUSPENDED', blocked: true });
    expect(derive({ isActive: false, managed: false, endsOn: null })).toMatchObject({ status: 'SUSPENDED', blocked: true });
  });
});

describe('nextPeriod', () => {
  it('starts today when nothing is running', () => {
    expect(nextPeriod(null, '2026-10-04', 30)).toEqual({ startsOn: '2026-10-04', endsOn: '2026-11-02' });
    expect(nextPeriod('2026-09-01', '2026-10-04', 1)).toEqual({ startsOn: '2026-10-04', endsOn: '2026-10-04' });
  });
  it('starts the day after the running period, so renewing early wastes no paid day', () => {
    expect(nextPeriod('2026-10-10', '2026-10-04', 365)).toEqual({ startsOn: '2026-10-11', endsOn: '2027-10-10' });
    expect(nextPeriod('2026-10-04', '2026-10-04', 7)).toEqual({ startsOn: '2026-10-05', endsOn: '2026-10-11' });
  });
  it('crosses a leap day correctly', () => {
    expect(nextPeriod(null, '2028-02-28', 2)).toEqual({ startsOn: '2028-02-28', endsOn: '2028-02-29' });
  });
});

describe('planAmount', () => {
  it('charges a Day-wise plan per day, exactly in paise', () => {
    expect(planAmount({ kind: 'DAYS', price: '33.33' }, 3)).toBe('99.99');
    expect(planAmount({ kind: 'DAYS', price: '0.10' }, 3)).toBe('0.30');
  });
  it('charges other plans their list price regardless of days', () => {
    expect(planAmount({ kind: 'MONTHLY', price: '499' }, 30)).toBe('499.00');
  });
});

describe('schemas', () => {
  it('requires a duration for every plan but Day-wise, and drops it for Day-wise', () => {
    expect(planSchema.safeParse({ name: 'M', kind: 'MONTHLY', price: '499' }).success).toBe(false);
    expect(planSchema.parse({ name: 'D', kind: 'DAYS', price: '49', durationDays: 5 })).toMatchObject({ durationDays: null });
  });
  it('rejects a money value with more than 2 decimals', () => {
    expect(grantSubscriptionSchema.safeParse({ planId: crypto.randomUUID(), amount: '10.001' }).success).toBe(false);
  });
  it('requires a 10-digit owner mobile and lowercases the email', () => {
    const base = { studioName: 'S', ownerFirstName: 'A', ownerEmail: 'A@B.COM', ownerMobile: '9876543210', ownerPassword: 'secret123', subscription: { planId: crypto.randomUUID() } };
    expect(createStudioSchema.parse(base).ownerEmail).toBe('a@b.com');
    expect(createStudioSchema.safeParse({ ...base, ownerMobile: '98765' }).success).toBe(false);
  });
});

describe('sign-in limiter (whenFull: refuse)', () => {
  it('cannot be reset by flooding it with junk keys', () => {
    const allow = fixedWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 5, whenFull: 'refuse' });
    expect([allow('admin', 0), allow('admin', 0), allow('admin', 0)]).toEqual([true, true, false]);
    for (let i = 0; i < 50; i++) allow(`junk${i}`, 0);
    expect(allow('admin', 0)).toBe(false);
    expect(allow('admin', 1000)).toBe(true); // the window passing still frees it
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Platform panel API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;
  let platformToday: () => string;

  const RUN = Math.random().toString(36).slice(2, 8);
  const PASSWORD = 'owner-pass-123';
  const tenantIds: string[] = [];
  const planIds: Record<string, string> = {};
  let adminId = '';
  let platformToken = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, token?: string, payload?: unknown) =>
    app.inject({ method, url, headers: token ? auth(token) : {}, payload: payload as object | undefined });
  const studioLogin = (email: string) => call('POST', '/api/auth/login', undefined, { email, password: PASSWORD });

  async function newStudio(label: string, subscription: Record<string, unknown> = { planId: planIds.TRIAL }) {
    const email = `${label}-${RUN}@test.local`;
    const res = await call('POST', '/api/platform/studios', platformToken, {
      studioName: `${label} ${RUN}`,
      ownerFirstName: 'Owner',
      ownerEmail: email,
      ownerMobile: '9876543210',
      ownerPassword: PASSWORD,
      subscription,
    });
    expect(res.statusCode, res.body).toBe(200);
    const studio = res.json().data as { id: string; access: { status: string; endsOn: string }; periods: { id: string; startsOn: string; endsOn: string; amount: string }[] };
    tenantIds.push(studio.id);
    return { studio, email };
  }

  /** Back-dates a studio's whole history so it ended `daysAgo` days ago. */
  async function endStudio(tenantId: string, daysAgo: number, kind = 'MONTHLY') {
    await db.update(schema.tenantSubscriptions).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'test' }).where(eq(schema.tenantSubscriptions.tenantId, tenantId));
    const endsOn = addDays(platformToday(), -daysAgo);
    await db.insert(schema.tenantSubscriptions).values({ tenantId, planId: planIds[kind], planName: kind, kind, days: 30, startsOn: addDays(endsOn, -29), endsOn, amount: '0' });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ eq, inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    ({ platformToday } = await import('../services/subscriptions'));
    app = await (await import('../server')).buildApp();
    await app.ready();

    const bcrypt = (await import('bcryptjs')).default;
    const [admin] = await db.insert(schema.platformAdmins).values({ name: 'Test Admin', email: `admin-${RUN}@test.local`, passwordHash: await bcrypt.hash('admin-pass-123', 10) }).returning();
    adminId = admin.id;
    const plans = await db
      .insert(schema.subscriptionPlans)
      .values([
        { name: `Trial ${RUN}`, kind: 'TRIAL', durationDays: 7, price: '0' },
        { name: `Days ${RUN}`, kind: 'DAYS', durationDays: null, price: '50' },
        { name: `Monthly ${RUN}`, kind: 'MONTHLY', durationDays: 30, price: '499' },
        { name: `Yearly ${RUN}`, kind: 'YEARLY', durationDays: 365, price: '4999' },
      ])
      .returning();
    for (const p of plans) planIds[p.kind] = p.id;
    platformToken = (await call('POST', '/api/platform/auth/login', undefined, { email: `ADMIN-${RUN}@test.local`, password: 'admin-pass-123' })).json().data.accessToken;
  });

  afterAll(async () => {
    if (tenantIds.length) await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds)); // cascades
    if (Object.keys(planIds).length) await db.delete(schema.subscriptionPlans).where(inArray(schema.subscriptionPlans.id, Object.values(planIds)));
    if (adminId) await db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.id, adminId));
    await app?.close();
    await sqlClient?.end();
  });

  describe('token separation', () => {
    it('signs a platform admin in', () => {
      expect(platformToken).toBeTruthy();
    });
    it('refuses a wrong platform password', async () => {
      expect((await call('POST', '/api/platform/auth/login', undefined, { email: `admin-${RUN}@test.local`, password: 'nope-nope' })).statusCode).toBe(401);
    });
    it('refuses a platform route without a token, and with a studio token', async () => {
      expect((await call('GET', '/api/platform/studios')).statusCode).toBe(401);
      const { email } = await newStudio('sep');
      const studioToken = (await studioLogin(email)).json().data.accessToken;
      expect((await call('GET', '/api/platform/studios', studioToken)).statusCode).toBe(401);
    });
    it('refuses a studio route with a platform token', async () => {
      expect((await call('GET', '/api/auth/me', platformToken)).statusCode).toBe(401);
    });
  });

  describe('creating a studio', () => {
    it('creates tenant, owner and a 7-day trial starting today; the owner can sign in', async () => {
      const { studio, email } = await newStudio('create');
      expect(studio.access.status).toBe('TRIAL');
      expect(studio.periods).toHaveLength(1);
      expect(studio.periods[0]).toMatchObject({ startsOn: platformToday(), endsOn: addDays(platformToday(), 6), amount: '0.00' });
      const login = await studioLogin(email);
      expect(login.statusCode).toBe(200);
      expect(login.json().data.user.subscription).toMatchObject({ status: 'TRIAL', daysLeft: 7 });
      expect(login.json().data.user.isSuperAdmin).toBe(true);
    });
    it('rejects an owner email already used by any studio user, and creates nothing', async () => {
      const { email } = await newStudio('dupe');
      const res = await call('POST', '/api/platform/studios', platformToken, { studioName: `dupe-fail ${RUN}`, ownerFirstName: 'x', ownerEmail: email, ownerMobile: '9876543210', ownerPassword: PASSWORD, subscription: { planId: planIds.TRIAL } });
      expect(res.statusCode).toBe(400);
      expect(await db.select().from(schema.tenants).where(eq(schema.tenants.name, `dupe-fail ${RUN}`))).toHaveLength(0);
    });
    it('rolls the whole studio back when the first grant is invalid', async () => {
      const res = await call('POST', '/api/platform/studios', platformToken, { studioName: `rollback-fail ${RUN}`, ownerFirstName: 'x', ownerEmail: `rollback-${RUN}@test.local`, ownerMobile: '9876543210', ownerPassword: PASSWORD, subscription: { planId: planIds.MONTHLY } });
      expect(res.statusCode).toBe(400); // paid plan without a payment mode
      expect(await db.select().from(schema.tenants).where(eq(schema.tenants.name, `rollback-fail ${RUN}`))).toHaveLength(0);
    });
    it('stops a studio admin from creating a user with an email another studio uses', async () => {
      const a = await newStudio('xa');
      const b = await newStudio('xb');
      const tokenB = (await studioLogin(b.email)).json().data.accessToken;
      const [role] = await db.select().from(schema.roles).where(eq(schema.roles.tenantId, b.studio.id)).limit(1);
      const res = await call('POST', '/api/admin/users', tokenB, { firstName: 'Clash', email: a.email, password: 'whatever123', roleId: role.id });
      expect(res.statusCode).toBe(400);
    });
    it('refuses a username equal to another studio user’s email (sign-in matches both columns)', async () => {
      const a = await newStudio('ua');
      const b = await newStudio('ub');
      const tokenB = (await studioLogin(b.email)).json().data.accessToken;
      const [role] = await db.select().from(schema.roles).where(eq(schema.roles.tenantId, b.studio.id)).limit(1);
      const res = await call('POST', '/api/admin/users', tokenB, { firstName: 'Clash', email: `other-${RUN}@test.local`, username: a.email.toUpperCase(), password: 'whatever123', roleId: role.id });
      expect(res.statusCode).toBe(400);
    });
    it('creates only one studio when the same owner is submitted twice at once', async () => {
      const email = `twice-${RUN}@test.local`;
      const body = { studioName: `twice ${RUN}`, ownerFirstName: 'T', ownerEmail: email, ownerMobile: '9876543210', ownerPassword: PASSWORD, subscription: { planId: planIds.TRIAL } };
      const res = await Promise.all([call('POST', '/api/platform/studios', platformToken, body), call('POST', '/api/platform/studios', platformToken, body)]);
      for (const r of res) if (r.statusCode === 200) tenantIds.push(r.json().data.id);
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    });
  });

  describe('granting', () => {
    it('chains a renewal onto the running period and charges the list price', async () => {
      const { studio } = await newStudio('renew');
      const res = await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.MONTHLY, paymentMode: 'UPI', paymentRef: 'UTR1' });
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json().data;
      const monthly = d.periods.find((p: { kind: string }) => p.kind === 'MONTHLY');
      expect(monthly).toMatchObject({ startsOn: addDays(platformToday(), 7), endsOn: addDays(platformToday(), 36), amount: '499.00', paymentMode: 'UPI', paidOn: platformToday() });
      expect(d.access).toMatchObject({ status: 'ACTIVE', endsOn: addDays(platformToday(), 36) });
    });
    it('prices a Day-wise grant per day and accepts an overridden amount', async () => {
      const { studio } = await newStudio('days');
      const d = (await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.DAYS, days: 3, paymentMode: 'CASH' })).json().data;
      expect(d.periods.find((p: { kind: string }) => p.kind === 'DAYS')).toMatchObject({ days: 3, amount: '150.00' });
      const d2 = (await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.DAYS, days: 2, amount: '80', paymentMode: 'CASH' })).json().data;
      expect(d2.periods.filter((p: { kind: string }) => p.kind === 'DAYS').map((p: { amount: string }) => p.amount)).toContain('80.00');
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.DAYS, paymentMode: 'CASH' })).statusCode).toBe(400);
    });
    it('allows one trial per studio', async () => {
      const { studio } = await newStudio('trial-once');
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.TRIAL })).statusCode).toBe(409);
    });
    it('never lets two concurrent renewals overlap', async () => {
      const { studio } = await newStudio('race');
      const grant = () => call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.MONTHLY, paymentMode: 'CASH' });
      const res = await Promise.all([grant(), grant(), grant()]);
      expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      const rows = await db.select().from(schema.tenantSubscriptions).where(eq(schema.tenantSubscriptions.tenantId, studio.id));
      const sorted = rows.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].startsOn).toBe(addDays(sorted[i - 1].endsOn, 1));
    });
    it('cancels a period and the expiry falls back to the remaining periods', async () => {
      const { studio } = await newStudio('cancel');
      const d = (await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.MONTHLY, paymentMode: 'CASH' })).json().data;
      const monthly = d.periods.find((p: { kind: string }) => p.kind === 'MONTHLY');
      const after = (await call('POST', `/api/platform/studios/${studio.id}/subscriptions/${monthly.id}/cancel`, platformToken, { reason: 'entered twice' })).json().data;
      expect(after.access).toMatchObject({ status: 'TRIAL', endsOn: addDays(platformToday(), 6) });
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions/${monthly.id}/cancel`, platformToken, { reason: 'again' })).statusCode).toBe(404);
    });
    it('refuses to cancel an earlier period while a later one exists (it would not shorten the expiry)', async () => {
      const { studio } = await newStudio('cancel-order');
      const grant = async () => (await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.MONTHLY, paymentMode: 'CASH' })).json().data;
      await grant();
      const d = await grant();
      const [first, second] = d.periods.filter((p: { kind: string }) => p.kind === 'MONTHLY').sort((x: { startsOn: string }, y: { startsOn: string }) => x.startsOn.localeCompare(y.startsOn));
      const early = await call('POST', `/api/platform/studios/${studio.id}/subscriptions/${first.id}/cancel`, platformToken, { reason: 'double entry' });
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('SUB_004');
      const after = (await call('POST', `/api/platform/studios/${studio.id}/subscriptions/${second.id}/cancel`, platformToken, { reason: 'double entry' })).json().data;
      expect(after.access.endsOn).toBe(first.endsOn);
    });
    it('refuses an amount too large for the column with a 400, not a database error', async () => {
      const { studio } = await newStudio('huge');
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.DAYS, days: 3000, amount: '9999999999', paymentMode: 'CASH' })).statusCode).toBe(200);
      const huge = await db.insert(schema.subscriptionPlans).values({ name: `Huge ${RUN}`, kind: 'DAYS', price: '99999999' }).returning();
      planIds.HUGE = huge[0].id;
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: huge[0].id, days: 3000, paymentMode: 'CASH' })).statusCode).toBe(400);
    });
  });

  describe('enforcement on the studio side', () => {
    it('keeps full access in grace, then turns read-only — reads and sign-in still work', async () => {
      const { studio, email } = await newStudio('expire');
      const token = (await studioLogin(email)).json().data.accessToken;
      const write = () => call('POST', '/api/masters/books', token, { bookNumber: `B-${Math.random().toString(36).slice(2, 8)}` });

      await endStudio(studio.id, 2); // grace
      expect((await write()).statusCode).toBe(200);

      await endStudio(studio.id, 4); // past grace
      const blocked = await write();
      expect(blocked.statusCode).toBe(402);
      expect(blocked.json().error.code).toBe('SUB_001');
      expect((await call('GET', '/api/masters/books', token)).statusCode).toBe(200);
      const me = await call('GET', '/api/auth/me', token);
      expect(me.json().data.subscription).toMatchObject({ status: 'EXPIRED', readOnly: true });
      expect((await studioLogin(email)).statusCode).toBe(200);
      // Every write verb is refused …
      const [book] = await db.select().from(schema.books).where(eq(schema.books.tenantId, studio.id)).limit(1);
      expect((await call('PUT', `/api/masters/books/${book.id}`, token, { bookNumber: 'RENAMED' })).statusCode).toBe(402);
      expect((await app.inject({ method: 'DELETE', url: `/api/masters/books/${book.id}`, headers: auth(token) })).statusCode).toBe(402);
      // … except the studio's own session and screen preferences.
      expect((await call('PUT', '/api/auth/change-password', token, { currentPassword: 'wrong-wrong', newPassword: 'whatever123' })).statusCode).toBe(400);
      expect((await call('PUT', '/api/column-preferences', token, { moduleName: 'books', columns: [{ key: 'bookNumber', visible: true }] })).statusCode).toBe(200);

      // Renewing restores writes immediately.
      await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.MONTHLY, paymentMode: 'CASH' });
      expect((await write()).statusCode).toBe(200);
    });
    it('suspension blocks sign-in, refresh and every request; activation restores them', async () => {
      const { studio, email } = await newStudio('suspend');
      const login = (await studioLogin(email)).json().data;
      await call('POST', `/api/platform/studios/${studio.id}/status`, platformToken, { isActive: false });
      expect((await call('GET', '/api/masters/books', login.accessToken)).json().error.code).toBe('SUB_003');
      expect((await studioLogin(email)).statusCode).toBe(403);
      expect((await call('POST', '/api/auth/refresh', undefined, { refreshToken: login.refreshToken })).statusCode).toBe(401); // its tokens were revoked
      await call('POST', `/api/platform/studios/${studio.id}/status`, platformToken, { isActive: true });
      expect((await studioLogin(email)).statusCode).toBe(200);
    });
    it('leaves a pre-SaaS studio with no periods unrestricted', async () => {
      const [tenant] = await db.insert(schema.tenants).values({ name: `legacy ${RUN}`, slug: `legacy-${RUN}` }).returning();
      tenantIds.push(tenant.id);
      const [role] = await db.insert(schema.roles).values({ tenantId: tenant.id, name: 'r', permissions: { masters_books: ['read', 'create'] } }).returning();
      const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, roleId: role.id, firstName: 'L', email: `legacy-${RUN}@test.local`, passwordHash: 'x' }).returning();
      const token = app.jwt.sign({ sub: user.id, tenantId: tenant.id });
      expect((await call('POST', '/api/masters/books', token, { bookNumber: 'LEGACY-1' })).statusCode).toBe(200);
      const list = (await call('GET', '/api/platform/studios', platformToken)).json().data as { id: string; access: { status: string } }[];
      expect(list.find((s) => s.id === tenant.id)?.access.status).toBe('UNMANAGED');
    });
    it('resets the owner password and signs the owner out', async () => {
      const { studio, email } = await newStudio('pwd');
      const login = (await studioLogin(email)).json().data;
      expect((await call('POST', `/api/platform/studios/${studio.id}/owner-password`, platformToken, { password: 'brand-new-pass' })).statusCode).toBe(200);
      expect((await studioLogin(email)).statusCode).toBe(401);
      expect((await call('POST', '/api/auth/login', undefined, { email, password: 'brand-new-pass' })).statusCode).toBe(200);
      expect((await call('POST', '/api/auth/refresh', undefined, { refreshToken: login.refreshToken })).statusCode).toBe(401);
    });
  });

  describe('platform sessions', () => {
    it('refuses the token of a platform admin who has been deactivated', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const [a] = await db.insert(schema.platformAdmins).values({ name: 'Gone', email: `gone-${RUN}@test.local`, passwordHash: await bcrypt.hash('gone-pass-123', 10) }).returning();
      const token = (await call('POST', '/api/platform/auth/login', undefined, { email: a.email, password: 'gone-pass-123' })).json().data.accessToken;
      expect((await call('GET', '/api/platform/summary', token)).statusCode).toBe(200);
      await db.update(schema.platformAdmins).set({ isActive: false }).where(eq(schema.platformAdmins.id, a.id));
      expect((await call('GET', '/api/platform/summary', token)).statusCode).toBe(403);
      await db.delete(schema.platformAdmins).where(eq(schema.platformAdmins.id, a.id));
    });
    it('refuses a studio-signed token that claims some other kind', async () => {
      const { studio } = await newStudio('kind');
      const [owner] = await db.select().from(schema.users).where(eq(schema.users.tenantId, studio.id));
      const forged = app.jwt.sign({ sub: owner.id, tenantId: studio.id, kind: 'admin' } as never);
      expect((await call('GET', '/api/platform/studios', forged)).statusCode).toBe(401);
    });
  });

  describe('plans', () => {
    it('lets the platform create its own plan, reports usage, and deletes only an unused one', async () => {
      const created = await call('POST', '/api/platform/plans', platformToken, { name: `Quarterly ${RUN}`, kind: 'MONTHLY', durationDays: 90, price: '1299' });
      expect(created.statusCode, created.body).toBe(200);
      const own = created.json().data as { id: string };
      planIds.OWN = own.id;
      const list = (await call('GET', '/api/platform/plans', platformToken)).json().data as { id: string; usedCount: number; price: string }[];
      expect(list.find((x) => x.id === own.id)).toMatchObject({ usedCount: 0, price: '1299.00' });
      expect(list.find((x) => x.id === planIds.TRIAL)!.usedCount).toBeGreaterThan(0);

      // A granted plan cannot be deleted — history refers to it.
      const used = await app.inject({ method: 'DELETE', url: `/api/platform/plans/${planIds.TRIAL}`, headers: auth(platformToken) });
      expect(used.statusCode).toBe(409);
      expect(used.json().error.code).toBe('SUB_005');

      expect((await app.inject({ method: 'DELETE', url: `/api/platform/plans/${own.id}`, headers: auth(platformToken) })).statusCode).toBe(200);
      delete planIds.OWN;
      expect((await app.inject({ method: 'DELETE', url: `/api/platform/plans/${own.id}`, headers: auth(platformToken) })).statusCode).toBe(404);
    });
    it('refuses to change a plan’s type', async () => {
      const res = await call('PUT', `/api/platform/plans/${planIds.MONTHLY}`, platformToken, { name: `Monthly ${RUN}`, kind: 'YEARLY', durationDays: 365, price: '1' });
      expect(res.statusCode).toBe(400);
    });
    it('refuses a grant on an inactive plan', async () => {
      const { studio } = await newStudio('inactive');
      await call('PUT', `/api/platform/plans/${planIds.YEARLY}`, platformToken, { name: `Yearly ${RUN}`, kind: 'YEARLY', durationDays: 365, price: '4999', isActive: false });
      expect((await call('POST', `/api/platform/studios/${studio.id}/subscriptions`, platformToken, { planId: planIds.YEARLY, paymentMode: 'CASH' })).statusCode).toBe(400);
    });
  });
});
