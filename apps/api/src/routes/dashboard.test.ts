import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dashboardQuerySchema, periodRange } from '@erp/shared';

/**
 * The Dashboard (docs/DASHBOARD.md). Section A is pure: the period ranges and the query schema.
 * Section B needs TEST_DATABASE_URL (a THROWAWAY database): the figures against real appointments,
 * bills, workflow stages and receipts; money equal to Reports → Receivables; sections by permission;
 * tenant isolation; and that reading the dashboard writes nothing.
 */

/* ======================================================= A — pure ===== */

describe('dashboard periods (from the business date)', () => {
  it('today, this month, last month — month ends and leap years', () => {
    expect(periodRange('TODAY', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(periodRange('THIS_MONTH', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('THIS_MONTH', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('LAST_MONTH', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('LAST_MONTH', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('the financial year runs 1 April – 31 March', () => {
    expect(periodRange('THIS_FY', '2026-04-01')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(periodRange('THIS_FY', '2027-03-31')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(periodRange('THIS_FY', '2026-10-01')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });

  it('the query: This month by default; Custom needs both dates in order', () => {
    expect(dashboardQuerySchema.parse({})).toEqual({ period: 'THIS_MONTH' });
    expect(dashboardQuerySchema.safeParse({ period: 'CUSTOM', from: '2026-10-01' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ period: 'CUSTOM', from: '2026-10-05', to: '2026-10-01' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ period: 'CUSTOM', from: '2026-10-01', to: '2026-13-01' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ period: 'YESTERDAY' }).success).toBe(false);
    expect(periodRange('CUSTOM', '2026-10-01', { from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });
});

/* ================================================= B — database ===== */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Dashboard (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  const FULL = { operations_appointments: ['read', 'create', 'update'], operations_billing: ['read', 'create', 'update'], operations_receipts: ['read', 'create'], operations_work: ['read', 'update'], reports_receivables: ['read'] };
  const req = (t: string, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });
  const dash = async (t: string, query = '') => {
    const r = await req(t, 'GET', `/api/dashboard${query}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data;
  };
  const T = { tenantId: '', admin: '', apptOnly: '', billingOnly: '', nothing: '', workOnly: '', receiptsOnly: '', receivablesOnly: '', other: '', today: '', billIds: [] as string[] };

  async function seedTenant(name: string) {
    const { seedTenantDefaults } = await import('../services/tenant-setup');
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    await seedTenantDefaults(db, tenant.id, { companyName: `${name} Studio` });
    const user = async (grants: Record<string, string[]>) => {
      const [role] = await db.insert(schema.roles).values({ tenantId: tenant.id, name: `${name} ${Math.random().toString(36).slice(2, 8)}`, permissions: grants }).returning();
      const [u] = await db.insert(schema.users).values({ tenantId: tenant.id, roleId: role.id, firstName: name, lastName: 'T', email: `${name}-${Math.random().toString(36).slice(2, 8)}@test.local`, passwordHash: 'x' }).returning();
      return app.jwt.sign({ sub: u.id, tenantId: tenant.id });
    };
    return { tenantId: tenant.id, user, admin: await user(FULL) };
  }
  const shift = (iso: string, days: number) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    ({ db, sql: sqlClient, schema } = client);
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('dash-a');
    Object.assign(T, { tenantId: a.tenantId, admin: a.admin });
    T.apptOnly = await a.user({ operations_appointments: ['read'] });
    T.billingOnly = await a.user({ operations_billing: ['read'] });
    T.nothing = await a.user({ masters_items: ['read'] });
    T.workOnly = await a.user({ operations_work: ['read'] });
    T.receiptsOnly = await a.user({ operations_receipts: ['read'] });
    T.receivablesOnly = await a.user({ reports_receivables: ['read'] });
    T.today = (await dash(a.admin, '?period=TODAY')).today;
    const today = T.today;

    // Appointments: two today (one done), one overdue pending, one far in the past and done.
    const appt = async (appointmentDate: string, done: boolean) => {
      const r = await req(a.admin, 'POST', '/api/appointments', { appointmentDate, customerName: 'Dash Customer', mobileNumber: '9876500033' });
      expect(r.statusCode, r.body).toBe(200);
      if (done) expect((await req(a.admin, 'POST', `/api/appointments/${r.json().data.id}/done`)).statusCode).toBe(200);
    };
    await appt(today, false);
    await appt(today, true);
    await appt(shift(today, -3), false);
    await appt(shift(today, -400), true);

    const [book] = await db.insert(schema.books).values({ tenantId: a.tenantId, bookNumber: 'D-2026', seriesStartsAt: 1, nextBillNumber: 1 }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId: a.tenantId, itemName: 'Photography', hsnCode: '9983', gstRate: '18.00' }).returning();
    const [sub] = await db.insert(schema.subItems).values({ tenantId: a.tenantId, itemId: item.id, productName: 'Shoot', rate: '1000.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId: a.tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId: a.tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    const bill = async (billDate: string, deliveryDate: string | null) => {
      const r = await req(a.admin, 'POST', '/api/bills', { bookId: book.id, billDate, deliveryDate, customerName: 'Dash Customer', mobileNumber: '9876500033', taxMode: 'WITH_GST', discountType: 'AMOUNT', discountValue: 0, items: [{ itemId: item.id, subItemId: sub.id, quantity: 1, rate: 1000 }] });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().data.id as string;
    };
    const stage = async (id: string, s: string, outcome = 'DONE') => expect((await req(a.admin, 'POST', `/api/work/bills/${id}/stages/${s}`, { outcome })).statusCode).toBe(200);
    // Four orders today: not started (due today), at Editing (overdue promise), at WhatsApp, delivered.
    const b1 = await bill(today, today);
    const b2 = await bill(today, shift(today, -1));
    await stage(b2, 'SELECTION');
    const b3 = await bill(today, null);
    await stage(b3, 'SELECTION');
    await stage(b3, 'EDITING');
    const b4 = await bill(today, shift(today, -2));
    await stage(b4, 'DELIVERY');
    // Delivery SKIPPED also closes the job: completed, never overdue (as in Reports → Delivery).
    const b6 = await bill(today, shift(today, -2));
    await stage(b6, 'DELIVERY', 'SKIPPED');
    // An old bill (outside "today"), still owing.
    const b5 = await bill(shift(today, -400), null);
    T.billIds = [b1, b2, b3, b4, b5, b6];
    // 500 received against b1 (and 200 left as unapplied advance — not payment on any bill).
    const r = await req(a.admin, 'POST', '/api/receipts', { receiptDate: today, customerMobile: '9876500033', customerName: 'Dash Customer', paymentMode: 'CASH', accountId: cash.id, amount: 700, allocations: [{ billId: b1, amount: 500 }] });
    expect(r.statusCode, r.body).toBe(200);

    const b = await seedTenant('dash-b');
    T.other = b.admin;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      const t = tenantIds;
      for (const tbl of [schema.advanceApplications, schema.receiptAllocations, schema.receipts, schema.publicInvoiceLinks, schema.billWorkStages, schema.billItems, schema.bills, schema.appointments, schema.accounts, schema.accountGroups, schema.subItems, schema.items, schema.books, schema.documentCounters, schema.invoiceTemplates, schema.companyPrintAssets, schema.companyLogos, schema.branches, schema.companies, schema.appSettings, schema.activityLogs, schema.users, schema.roles] as const) {
        await db.delete(tbl).where(inArray((tbl as any).tenantId, t));
      }
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, t));
    }
    await app?.close();
    await sqlClient?.end();
  });

  it('today: inquiries, orders by workflow position, attention figures', async () => {
    const d = await dash(T.admin, '?period=TODAY');
    expect(d).toMatchObject({ period: 'TODAY', from: T.today, to: T.today });
    expect(d.inquiries).toEqual({ total: 2, pending: 1, done: 1, pendingToday: 1, overdue: 1 });
    expect(d.orders).toEqual({
      total: 5, completed: 2, pending: 3,
      byPosition: { SELECTION: 1, EDITING: 1, WHATSAPP: 1, DELIVERY: 0, COMPLETE: 2 },
      // b1 is due today; b2 was promised yesterday and is not delivered. b4 delivered and b6 skipped — never overdue.
      dueToday: 1, overdue: 1,
    });
  });

  it('money is exactly Reports → Receivables: period and all-time, unapplied advance excluded', async () => {
    const d = await dash(T.admin, '?period=TODAY');
    const period = (await req(T.admin, 'GET', `/api/reports/receivables/overview?asOf=${T.today}&from=${T.today}&to=${T.today}`)).json().data;
    const all = (await req(T.admin, 'GET', `/api/reports/receivables/overview?asOf=${T.today}`)).json().data;
    expect(d.money).toEqual({
      billed: period.totalBilled, received: period.totalReceived, outstanding: period.totalOutstanding,
      totalOutstanding: all.totalOutstanding, billsWithOutstanding: all.pendingBills, customersWithOutstanding: all.customersWithOutstanding,
    });
    expect(d.money.received).toBe(500);
    expect(d.money.billsWithOutstanding).toBe(6);
    expect(d.money.billed + 1180).toBeCloseTo(all.totalBilled, 2); // the old bill is outside today's period
  });

  it('a custom period over a year ago sees only the old records', async () => {
    const day = shift(T.today, -400);
    const d = await dash(T.admin, `?period=CUSTOM&from=${day}&to=${day}`);
    expect(d.inquiries).toMatchObject({ total: 1, pending: 0, done: 1 });
    expect(d.orders).toMatchObject({ total: 1, completed: 0, pending: 1 });
    // Today's attention figures do not depend on the period.
    expect(d.orders.dueToday).toBe(1);
    expect((await req(T.admin, 'GET', '/api/dashboard?period=CUSTOM&from=2026-10-05&to=2026-10-01')).statusCode).toBe(400);
  });

  it('sections follow permissions — decided by the server', async () => {
    const appt = await dash(T.apptOnly);
    expect(appt.inquiries).toBeDefined();
    expect(appt.orders).toBeUndefined();
    expect(appt.money).toBeUndefined();
    const billing = await dash(T.billingOnly);
    expect(billing.inquiries).toBeUndefined();
    expect(billing.orders).toBeDefined();
    expect(billing.money).toBeDefined();
    // Studio Work alone: order counts, never money. Receipts or Receivables alone: money, never orders.
    const work = await dash(T.workOnly);
    expect([!!work.inquiries, !!work.orders, !!work.money]).toEqual([false, true, false]);
    for (const t of [T.receiptsOnly, T.receivablesOnly]) {
      const m = await dash(t);
      expect([!!m.inquiries, !!m.orders, !!m.money]).toEqual([false, false, true]);
    }
    const none = await dash(T.nothing);
    expect([none.inquiries, none.orders, none.money]).toEqual([undefined, undefined, undefined]);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('is tenant-isolated, and reading it writes nothing', async () => {
    const other = await dash(T.other, '?period=THIS_FY');
    expect(other.inquiries.total).toBe(0);
    expect(other.orders.total).toBe(0);
    expect(other.money.totalOutstanding).toBe(0);
    const before = await db.select().from(schema.bills).where(inArray(schema.bills.id, T.billIds));
    await dash(T.admin, '?period=THIS_FY');
    const after = await db.select().from(schema.bills).where(inArray(schema.bills.id, T.billIds));
    expect(after).toEqual(before);
  });
});
