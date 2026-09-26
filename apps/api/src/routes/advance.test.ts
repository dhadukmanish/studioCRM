import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGING_BUCKETS, toPaise } from '@erp/shared';

/**
 * Customer advance (docs/ADVANCE_PAYMENTS.md): money received beyond a receipt's allocations — or
 * before any bill exists — is the customer's ADVANCE. It reduces no bill until an explicit Apply
 * writes an `advance_applications` row; a mistaken Apply is REVERSED, never deleted.
 *
 *   Paid (bill)          = allocations on ACTIVE receipts + ACTIVE applications on ACTIVE receipts
 *   Available (receipt)  = amount - allocations - ACTIVE applications   (0 once cancelled)
 *
 * Needs TEST_DATABASE_URL (a THROWAWAY database). Every money figure is asserted exactly.
 */

const TEST_DB = process.env.TEST_DATABASE_URL;

/** Calendar arithmetic on the digits of a YYYY-MM-DD business date (UTC, so no zone can shift it). */
const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

describe.skipIf(!TEST_DB)('Customer advance (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let and: typeof import('drizzle-orm').and;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  const FULL = {
    operations_billing: ['read', 'create', 'update', 'delete'],
    operations_receipts: ['read', 'create', 'update'],
    reports_receivables: ['read'],
  };

  const req = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  /* ---------------------------------------------------------- fixtures -- */

  async function seedTenant(name: string) {
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    return { tenantId: tenant.id, token: await seedUser(tenant.id, name, FULL) };
  }
  async function seedUser(tenantId: string, name: string, grants: Record<string, string[]>) {
    const [role] = await db.insert(schema.roles).values({ tenantId, name: `${name} role ${Math.random().toString(36).slice(2, 6)}`, permissions: grants }).returning();
    const [user] = await db
      .insert(schema.users)
      .values({ tenantId, roleId: role.id, firstName: name, lastName: 'Tester', email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: 'not-a-real-hash' })
      .returning();
    return app.jwt.sign({ sub: user.id, tenantId });
  }
  async function seedMasters(tenantId: string) {
    const [item] = await db.insert(schema.items).values({ tenantId, itemName: `Item-${Math.random().toString(36).slice(2, 8)}`, hsnCode: '9983', gstRate: '0.00' }).returning();
    const [subItem] = await db.insert(schema.subItems).values({ tenantId, itemId: item.id, productName: `Prod-${Math.random().toString(36).slice(2, 8)}`, rate: '100.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    return { tenantId, item, subItem, cash, bookId: await newBook(tenantId) };
  }
  type Masters = Awaited<ReturnType<typeof seedMasters>>;

  /** A WITHOUT_GST book — a report scope of its own when a test filters by it. */
  async function newBook(tenantId: string) {
    const [book] = await db.insert(schema.books).values({ tenantId, bookNumber: `AD${Math.random().toString(36).slice(2, 8)}`, seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    return book.id;
  }
  const newMobile = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

  type Bill = { id: string; billNumber: number; bookNumber: string; grandTotal: number; customerName: string };
  /** A 0% WITHOUT_GST bill whose Grand Total is exactly `total`, dated `day0` unless overridden. */
  async function bill(token: string, m: Masters, mobile: string, total: number, overrides: Record<string, unknown> = {}) {
    const res = await req(token, 'POST', '/api/bills', {
      bookId: m.bookId,
      billDate: day0,
      customerName: 'Advance Customer',
      mobileNumber: mobile,
      taxMode: 'WITHOUT_GST',
      items: [{ itemId: m.item.id, subItemId: m.subItem.id, quantity: 1, rate: total }],
      ...overrides,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Bill;
  }

  type Receipt = { id: string; receiptNumber: number; amount: number; appliedAmount: number; availableAmount: number; customerName: string; mobileNumber: string; status: string; billNumbers: string; applications: { id: string; billId: string; bookNumber: string; billNumber: number; amount: number; status: string; appliedOn: string }[] };
  const receiptBody = (m: Masters, mobile: string, amount: number, overrides: Record<string, unknown> = {}) => ({
    receiptDate: day0,
    customerMobile: mobile,
    paymentMode: 'CASH',
    accountId: m.cash.id,
    amount,
    allocations: [],
    customerName: 'Advance Customer',
    ...overrides,
  });
  /** A receipt of `amount`; with no allocations the whole of it is advance. */
  async function advance(token: string, m: Masters, mobile: string, amount: number, overrides: Record<string, unknown> = {}) {
    const res = await req(token, 'POST', '/api/receipts', receiptBody(m, mobile, amount, overrides));
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Receipt;
  }
  const receiptOf = async (token: string, id: string) => {
    const res = await req(token, 'GET', `/api/receipts/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Receipt;
  };
  const advanceOf = async (token: string, mobile: string) => {
    const res = await req(token, 'GET', `/api/receipts/advance?customer=${mobile}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { customerKey: string; availableAdvance: number; receipts: { id: string; availableAmount: number; amount: number }[] };
  };
  type Payments = { grandTotal: number; paidAmount: number; outstandingAmount: number; paymentStatus: string; availableAdvance: number; advanceToApply: number; history: { kind: string; amount: number; counts: boolean; applicationId: string | null; applicationStatus: string | null }[] };
  const payments = async (token: string, billId: string) => {
    const res = await req(token, 'GET', `/api/bills/${billId}/payments`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Payments;
  };
  const apply = (token: string, billId: string, amount: number) => req(token, 'POST', '/api/receipts/apply-advance', { billId, amount });
  const applyOk = async (token: string, billId: string, amount: number) => {
    const res = await apply(token, billId, amount);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { amount: number; used: { receiptId: string; amount: number }[] };
  };
  const reverse = (token: string, applicationId: string) => req(token, 'POST', `/api/receipts/applications/${applicationId}/reverse`, { reason: 'test reversal' });
  /** What is ACTIVE-applied from one receipt, straight from the table, in paise. */
  const appliedPaiseOf = async (receiptId: string) =>
    (await db.select().from(schema.advanceApplications).where(and(eq(schema.advanceApplications.receiptId, receiptId), eq(schema.advanceApplications.status, 'ACTIVE')))).reduce((s, r) => s + toPaise(r.amount), 0);

  /* ------------------------------------------------------------- state -- */

  let A = { tenantId: '', token: '', receiptsRead: '', receiptsCreate: '' };
  let mA: Masters;
  let B = { tenantId: '', token: '' };
  let mB: Masters;
  /** Today's business date, as the server sees it — never the machine clock. */
  let today = '';
  /** Bill and receipt date for most fixtures: well before today, so an As-of of yesterday still sees them. */
  let day0 = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ and, eq, inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('adv-tenant-a');
    A = {
      ...a,
      receiptsRead: await seedUser(a.tenantId, 'adv-receipts-read', { operations_billing: ['read'], operations_receipts: ['read'] }),
      receiptsCreate: await seedUser(a.tenantId, 'adv-receipts-create', { operations_billing: ['read'], operations_receipts: ['read', 'create'] }),
    };
    mA = await seedMasters(A.tenantId);
    B = await seedTenant('adv-tenant-b');
    mB = await seedMasters(B.tenantId);

    const overview = await req(A.token, 'GET', '/api/reports/receivables/overview');
    expect(overview.statusCode, overview.body).toBe(200);
    today = overview.json().data.asOf;
    day0 = addDays(today, -10);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      const t = tenantIds;
      await db.delete(schema.advanceApplications).where(inArray(schema.advanceApplications.tenantId, t));
      await db.delete(schema.receiptAllocations).where(inArray(schema.receiptAllocations.tenantId, t));
      await db.delete(schema.receipts).where(inArray(schema.receipts.tenantId, t));
      await db.delete(schema.billWorkStages).where(inArray(schema.billWorkStages.tenantId, t));
      await db.delete(schema.publicInvoiceLinks).where(inArray(schema.publicInvoiceLinks.tenantId, t));
      await db.delete(schema.billItems).where(inArray(schema.billItems.tenantId, t));
      await db.delete(schema.bills).where(inArray(schema.bills.tenantId, t));
      await db.delete(schema.appointments).where(inArray(schema.appointments.tenantId, t));
      await db.delete(schema.accounts).where(inArray(schema.accounts.tenantId, t));
      await db.delete(schema.accountGroups).where(inArray(schema.accountGroups.tenantId, t));
      await db.delete(schema.subItems).where(inArray(schema.subItems.tenantId, t));
      await db.delete(schema.items).where(inArray(schema.items.tenantId, t));
      await db.delete(schema.books).where(inArray(schema.books.tenantId, t));
      await db.delete(schema.documentCounters).where(inArray(schema.documentCounters.tenantId, t));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, t));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, t));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, t));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, t));
    }
    await app?.close();
    await sqlClient?.end();
  });

  /* ------------------------------------------------- advance before a bill -- */

  describe('advance received before any bill', () => {
    it('a receipt with no allocations for a new 10-digit customer is wholly advance', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000, { customerName: 'Priya Shah' });
      expect(r).toMatchObject({ amount: 5000, appliedAmount: 0, availableAmount: 5000, status: 'ACTIVE', customerName: 'Priya Shah', mobileNumber: mobile });
      expect(await advanceOf(A.token, mobile)).toEqual({ customerKey: mobile, availableAdvance: 5000, receipts: [expect.objectContaining({ id: r.id, amount: 5000, availableAmount: 5000 })] });
    });

    it('refuses a new customer whose mobile is not exactly 10 digits, on customerMobile', async () => {
      const res = await req(A.token, 'POST', '/api/receipts', receiptBody(mA, '98765 4321', 5000));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual([expect.objectContaining({ path: ['customerMobile'] })]);
      expect(await advanceOf(A.token, '987654321')).toMatchObject({ availableAdvance: 0, receipts: [] });
    });

    it('refuses a new customer with no name, on customerName', async () => {
      const mobile = newMobile();
      const res = await req(A.token, 'POST', '/api/receipts', receiptBody(mA, mobile, 5000, { customerName: '  ' }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual([expect.objectContaining({ path: ['customerName'] })]);
      expect((await advanceOf(A.token, mobile)).availableAdvance).toBe(0);
    });

    it("ignores the posted name for a customer who already has a bill — the bill's name wins", async () => {
      const mobile = newMobile();
      await bill(A.token, mA, mobile, 1000, { customerName: 'Billed Name' });
      const r = await advance(A.token, mA, mobile, 700, { customerName: 'Typed Other Name' });
      expect(r).toMatchObject({ customerName: 'Billed Name', availableAmount: 700 });
    });

    it('a customer who already has a bill needs no name for a plain advance', async () => {
      const mobile = newMobile();
      await bill(A.token, mA, mobile, 1000);
      const r = await advance(A.token, mA, mobile, 250.5, { customerName: null });
      expect(r).toMatchObject({ amount: 250.5, availableAmount: 250.5 });
    });
  });

  /* ---------------------------------------------------------- applying -- */

  describe('applying advance to a bill', () => {
    it('₹5,000 advance, then a ₹20,000 bill: Apply ₹5,000 -> Paid ₹5,000, Outstanding ₹15,000, advance used up', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b = await bill(A.token, mA, mobile, 20000);

      expect(await payments(A.token, b.id)).toMatchObject({ grandTotal: 20000, paidAmount: 0, outstandingAmount: 20000, paymentStatus: 'UNPAID', availableAdvance: 5000, advanceToApply: 5000, history: [] });

      const applied = await applyOk(A.token, b.id, 5000);
      expect(applied).toMatchObject({ amount: 5000, used: [{ receiptId: r.id, receiptNumber: r.receiptNumber, amount: 5000 }] });

      const after = await payments(A.token, b.id);
      expect(after).toMatchObject({ grandTotal: 20000, paidAmount: 5000, outstandingAmount: 15000, paymentStatus: 'PARTIALLY_PAID', availableAdvance: 0, advanceToApply: 0 });
      expect(after.history).toEqual([expect.objectContaining({ kind: 'ADVANCE', amount: 5000, counts: true, applicationStatus: 'ACTIVE' })]);
      expect(await receiptOf(A.token, r.id)).toMatchObject({ amount: 5000, appliedAmount: 5000, availableAmount: 0 });
      expect(await advanceOf(A.token, mobile)).toMatchObject({ availableAdvance: 0, receipts: [] });
    });

    it('applies part of an advance, then more of it to the same bill — two application rows', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b = await bill(A.token, mA, mobile, 20000);
      await applyOk(A.token, b.id, 2000);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 2000, outstandingAmount: 18000, availableAdvance: 3000, advanceToApply: 3000 });
      await applyOk(A.token, b.id, 3000);

      const rec = await receiptOf(A.token, r.id);
      expect(rec).toMatchObject({ appliedAmount: 5000, availableAmount: 0 });
      expect(rec.applications.map((x) => [x.billId, x.amount, x.status])).toEqual([
        [b.id, 2000, 'ACTIVE'],
        [b.id, 3000, 'ACTIVE'],
      ]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000, paymentStatus: 'PARTIALLY_PAID', availableAdvance: 0 });
    });

    it('advance larger than the bill: proposes the outstanding, leaves the rest available, refuses more than outstanding', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 10000);
      const b = await bill(A.token, mA, mobile, 6000);
      expect(await payments(A.token, b.id)).toMatchObject({ outstandingAmount: 6000, availableAdvance: 10000, advanceToApply: 6000 });

      const over = await apply(A.token, b.id, 6000.01);
      expect(over.statusCode).toBe(400);
      expect(over.json().error.details).toEqual([expect.objectContaining({ path: ['amount'] })]);
      expect(await appliedPaiseOf(r.id)).toBe(0);

      await applyOk(A.token, b.id, 6000);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 6000, outstandingAmount: 0, paymentStatus: 'PAID', availableAdvance: 4000, advanceToApply: 0 });
      expect(await receiptOf(A.token, r.id)).toMatchObject({ appliedAmount: 6000, availableAmount: 4000 });

      const paidAlready = await apply(A.token, b.id, 1);
      expect(paidAlready.statusCode).toBe(400);
      expect(paidAlready.json().error.details).toEqual([expect.objectContaining({ path: ['amount'] })]);
      expect((await advanceOf(A.token, mobile)).availableAdvance).toBe(4000);
    });

    it('refuses more than the available advance, to the paisa', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 1234.56);
      const b = await bill(A.token, mA, mobile, 5000);
      const res = await apply(A.token, b.id, 1234.57);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual([expect.objectContaining({ path: ['amount'] })]);
      await applyOk(A.token, b.id, 1234.56);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 1234.56, outstandingAmount: 3765.44, availableAdvance: 0 });
      expect(await receiptOf(A.token, r.id)).toMatchObject({ availableAmount: 0 });
    });

    it('spends the OLDEST advance first (by receipt date, not by creation order), across several bills', async () => {
      const mobile = newMobile();
      // Created first, dated later.
      const newer = await advance(A.token, mA, mobile, 4000, { receiptDate: addDays(day0, 2) });
      const older = await advance(A.token, mA, mobile, 3000, { receiptDate: day0 });
      const b1 = await bill(A.token, mA, mobile, 5000);
      const b2 = await bill(A.token, mA, mobile, 5000);
      expect(await advanceOf(A.token, mobile)).toMatchObject({ availableAdvance: 7000, receipts: [{ id: older.id }, { id: newer.id }] });

      const first = await applyOk(A.token, b1.id, 5000);
      expect(first.used).toEqual([
        { receiptId: older.id, receiptNumber: older.receiptNumber, amount: 3000 },
        { receiptId: newer.id, receiptNumber: newer.receiptNumber, amount: 2000 },
      ]);
      expect(await receiptOf(A.token, older.id)).toMatchObject({ appliedAmount: 3000, availableAmount: 0 });
      expect(await receiptOf(A.token, newer.id)).toMatchObject({ appliedAmount: 2000, availableAmount: 2000 });

      await applyOk(A.token, b2.id, 2000);
      expect(await receiptOf(A.token, newer.id)).toMatchObject({ appliedAmount: 4000, availableAmount: 0 });
      expect(await payments(A.token, b1.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 0, paymentStatus: 'PAID' });
      expect(await payments(A.token, b2.id)).toMatchObject({ paidAmount: 2000, outstandingAmount: 3000, paymentStatus: 'PARTIALLY_PAID', availableAdvance: 0 });

      const none = await apply(A.token, b2.id, 1);
      expect(none.statusCode).toBe(400);
    });

    it('a receipt of ₹12,000 allocating ₹10,000 to a bill keeps ₹2,000 as advance', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      const r = await advance(A.token, mA, mobile, 12000, { allocations: [{ billId: b.id, amount: 10000 }] });
      expect(r).toMatchObject({ amount: 12000, appliedAmount: 10000, availableAmount: 2000 });
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 10000, outstandingAmount: 0, paymentStatus: 'PAID', availableAdvance: 2000, advanceToApply: 0 });
      expect(await advanceOf(A.token, mobile)).toMatchObject({ availableAdvance: 2000, receipts: [{ id: r.id, availableAmount: 2000 }] });
    });

    it("one customer's advance is never applied to another customer's bill", async () => {
      const payer = newMobile();
      const other = newMobile();
      await advance(A.token, mA, payer, 5000);
      const b = await bill(A.token, mA, other, 5000);
      expect(await payments(A.token, b.id)).toMatchObject({ availableAdvance: 0, advanceToApply: 0 });
      const res = await apply(A.token, b.id, 1000);
      expect(res.statusCode).toBe(400);
      expect((await advanceOf(A.token, payer)).availableAdvance).toBe(5000);
      expect((await payments(A.token, b.id)).paidAmount).toBe(0);
    });

    it('refuses zero, negative and 3-decimal amounts, and an unknown bill', async () => {
      const mobile = newMobile();
      await advance(A.token, mA, mobile, 100);
      const b = await bill(A.token, mA, mobile, 100);
      for (const amount of [0, -5, 1.005]) expect((await apply(A.token, b.id, amount)).statusCode, String(amount)).toBe(400);
      expect((await apply(A.token, '00000000-0000-4000-8000-00000000abcd', 10)).statusCode).toBe(404);
      expect((await payments(A.token, b.id)).paidAmount).toBe(0);
    });
  });

  /* --------------------------------------------------------- concurrency -- */

  describe('concurrency — the same advance is never applied twice', () => {
    it('two ₹5,000 applies racing for ₹5,000 advance on two bills: exactly one commits', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b1 = await bill(A.token, mA, mobile, 5000);
      const b2 = await bill(A.token, mA, mobile, 5000);
      const results = await Promise.all([apply(A.token, b1.id, 5000), apply(A.token, b2.id, 5000)]);
      expect(results.map((x) => x.statusCode).sort()).toEqual([200, 400]);
      expect(await appliedPaiseOf(r.id)).toBe(500000);
      const paid = toPaise((await payments(A.token, b1.id)).paidAmount) + toPaise((await payments(A.token, b2.id)).paidAmount);
      expect(paid).toBe(500000);
      expect(await receiptOf(A.token, r.id)).toMatchObject({ appliedAmount: 5000, availableAmount: 0 });
    });

    it('two ₹5,000 applies racing on the same bill: exactly one commits', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b = await bill(A.token, mA, mobile, 20000);
      const results = await Promise.all([apply(A.token, b.id, 5000), apply(A.token, b.id, 5000)]);
      expect(results.map((x) => x.statusCode).sort()).toEqual([200, 400]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000, availableAdvance: 0 });
      expect(await appliedPaiseOf(r.id)).toBe(500000);
    });

    it('ten ₹1,000 applies racing for ₹5,000 spread over two receipts: exactly five commit, not a paisa over', async () => {
      const mobile = newMobile();
      const r1 = await advance(A.token, mA, mobile, 2500);
      const r2 = await advance(A.token, mA, mobile, 2500, { receiptDate: addDays(day0, 1) });
      const b = await bill(A.token, mA, mobile, 20000);
      const results = await Promise.all(Array.from({ length: 10 }, () => apply(A.token, b.id, 1000)));
      expect(results.filter((x) => x.statusCode === 200)).toHaveLength(5);
      expect(results.filter((x) => x.statusCode === 400)).toHaveLength(5);
      expect((await appliedPaiseOf(r1.id)) + (await appliedPaiseOf(r2.id))).toBe(500000);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000, availableAdvance: 0 });
    });
  });

  /* -------------------------------------------------- cancel and reverse -- */

  describe('cancelling and reversing', () => {
    it('a receipt with applied advance cannot be cancelled; reverse first, then cancel removes the advance', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b = await bill(A.token, mA, mobile, 20000);
      await applyOk(A.token, b.id, 5000);

      const refused = await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'wrong' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('RECEIPT_ADVANCE_APPLIED');
      expect(await receiptOf(A.token, r.id)).toMatchObject({ status: 'ACTIVE', appliedAmount: 5000, availableAmount: 0 });
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000 });

      const applicationId = (await receiptOf(A.token, r.id)).applications[0].id;
      const reversed = await reverse(A.token, applicationId);
      expect(reversed.statusCode, reversed.body).toBe(200);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 20000, paymentStatus: 'UNPAID', availableAdvance: 5000, advanceToApply: 5000 });
      const afterReverse = await receiptOf(A.token, r.id);
      expect(afterReverse).toMatchObject({ appliedAmount: 0, availableAmount: 5000 });
      expect(afterReverse.applications).toEqual([expect.objectContaining({ id: applicationId, amount: 5000, status: 'REVERSED' })]);
      // The reversed application stays in the bill's history and stops counting.
      expect((await payments(A.token, b.id)).history).toEqual([expect.objectContaining({ kind: 'ADVANCE', amount: 5000, counts: false, applicationStatus: 'REVERSED' })]);

      const again = await reverse(A.token, applicationId);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('APPLICATION_ALREADY_REVERSED');
      expect((await payments(A.token, b.id)).availableAdvance).toBe(5000);

      const cancelled = await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'refunded' });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().data).toMatchObject({ status: 'CANCELLED', availableAmount: 0 });
      expect(await advanceOf(A.token, mobile)).toMatchObject({ availableAdvance: 0, receipts: [] });
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 20000, paymentStatus: 'UNPAID', availableAdvance: 0, advanceToApply: 0 });
      expect((await apply(A.token, b.id, 1)).statusCode).toBe(400);
    });

    it('a cancel racing an apply of the same advance: never both — the bill never keeps money from a cancelled receipt', async () => {
      for (let i = 0; i < 5; i++) {
        const mobile = newMobile();
        const r = await advance(A.token, mA, mobile, 5000);
        const b = await bill(A.token, mA, mobile, 20000);
        const [cancel, applied] = await Promise.all([req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {}), apply(A.token, b.id, 5000)]);
        expect([cancel.statusCode, applied.statusCode].sort(), `${cancel.body} ${applied.body}`).toEqual(cancel.statusCode === 200 ? [200, 400] : [200, 409]);
        const p = await payments(A.token, b.id);
        if (cancel.statusCode === 200) expect(p).toMatchObject({ paidAmount: 0, outstandingAmount: 20000, availableAdvance: 0 });
        else expect(p).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000, availableAdvance: 0 });
      }
    });

    it('two reverses of the same application racing: exactly one succeeds', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 5000);
      const b = await bill(A.token, mA, mobile, 20000);
      await applyOk(A.token, b.id, 5000);
      const applicationId = (await receiptOf(A.token, r.id)).applications[0].id;
      const results = await Promise.all([reverse(A.token, applicationId), reverse(A.token, applicationId)]);
      expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, availableAdvance: 5000 });
    });

    it('reversing an unknown application is 404', async () => {
      expect((await reverse(A.token, '00000000-0000-4000-8000-00000000beef')).statusCode).toBe(404);
    });
  });

  /* ----------------------------------------------------- bill edit/delete -- */

  describe('a bill carrying applied advance', () => {
    const edit = (billId: string, mobile: string, rate: number) =>
      req(A.token, 'PUT', `/api/bills/${billId}`, {
        billDate: day0,
        customerName: 'Advance Customer',
        mobileNumber: mobile,
        taxMode: 'WITHOUT_GST',
        items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate }],
      });

    it('cannot be deleted — not even after the application is reversed (payment history)', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 3000);
      const b = await bill(A.token, mA, mobile, 5000);
      await applyOk(A.token, b.id, 3000);
      // Applied advance alone (no allocation) is payment history: the bill cannot move to another customer.
      expect((await edit(b.id, newMobile(), 5000)).statusCode).toBe(400);

      const refused = await req(A.token, 'DELETE', `/api/bills/${b.id}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('BILL_HAS_PAYMENTS');

      await reverse(A.token, (await receiptOf(A.token, r.id)).applications[0].id);
      const stillRefused = await req(A.token, 'DELETE', `/api/bills/${b.id}`);
      expect(stillRefused.statusCode).toBe(409);
      expect(stillRefused.json().error.code).toBe('BILL_HAS_PAYMENTS');
      expect((await payments(A.token, b.id)).grandTotal).toBe(5000);
    });

    it('cannot be edited below Paid (allocation + applied advance); exactly Paid is allowed', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      await advance(A.token, mA, mobile, 6000, { allocations: [{ billId: b.id, amount: 4000 }] });
      await applyOk(A.token, b.id, 2000);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 6000, outstandingAmount: 4000 });

      const refused = await edit(b.id, mobile, 5999.99);
      expect(refused.statusCode).toBe(400);
      expect((await payments(A.token, b.id)).grandTotal).toBe(10000);

      const allowed = await edit(b.id, mobile, 6000);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(await payments(A.token, b.id)).toMatchObject({ grandTotal: 6000, paidAmount: 6000, outstandingAmount: 0, paymentStatus: 'PAID' });
    });
  });

  /* ------------------------------------------------------ reconciliation -- */

  describe('receivables reconcile with applied advance', () => {
    const R = '/api/reports/receivables';
    const get = async <T = any>(path: string, query: Record<string, string>) => {
      const res = await req(A.token, 'GET', `${R}${path}?${new URLSearchParams(query)}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().data as T;
    };
    const agingPaise = (a: Record<string, number>) => AGING_BUCKETS.reduce((s, k) => s + toPaise(a[k]), 0);

    it('applied advance is received; unapplied advance reduces nothing; As of before the application day excludes it', async () => {
      const m = { ...mA, bookId: await newBook(A.tenantId) };
      const x = newMobile();
      const y = newMobile();
      const xr = await advance(A.token, m, x, 5000);
      const xb = await bill(A.token, m, x, 20000);
      const yb = await bill(A.token, m, y, 1000);
      await advance(A.token, m, y, 3000); // Y's advance stays unapplied.
      await applyOk(A.token, xb.id, 5000);
      const scope = { bookId: m.bookId };

      // Today (the application day).
      const overview = await get('/overview', scope);
      expect(overview).toMatchObject({ asOf: today, totalBilled: 21000, totalReceived: 5000, totalOutstanding: 16000, pendingBills: 2, customersWithOutstanding: 2 });
      expect(agingPaise(overview.aging)).toBe(toPaise(16000));

      const bills = await get<{ rows: any[]; totals: any }>('/bills', { ...scope, status: 'ALL', limit: '100' });
      const byId = new Map(bills.rows.map((r) => [r.id, r]));
      expect(byId.get(xb.id)).toMatchObject({ grandTotal: 20000, paidAmount: 5000, outstandingAmount: 15000, paymentStatus: 'PARTIALLY_PAID' });
      expect(byId.get(yb.id)).toMatchObject({ grandTotal: 1000, paidAmount: 0, outstandingAmount: 1000, paymentStatus: 'UNPAID' });
      expect(bills.totals).toMatchObject({ totalBilled: 21000, totalPaid: 5000, totalOutstanding: 16000 });
      expect(agingPaise(bills.totals.aging)).toBe(toPaise(16000));

      const detail = await get('/customers/' + x, scope);
      expect(detail.customer).toMatchObject({ totalBilled: 20000, totalPaid: 5000, totalOutstanding: 15000, pendingBills: 1 });
      expect(detail.receipts).toEqual([expect.objectContaining({ receiptId: xr.id, receiptAmount: 5000, allocatedAmount: 5000, status: 'ACTIVE', allocations: [expect.objectContaining({ billId: xb.id, amount: 5000 })] })]);
      const yDetail = await get('/customers/' + y, scope);
      expect(yDetail.customer).toMatchObject({ totalPaid: 0, totalOutstanding: 1000 });
      expect(yDetail.receipts).toEqual([]);

      // As of yesterday: the bills and receipts existed, the application did not.
      const yesterday = addDays(today, -1);
      const past = await get('/overview', { ...scope, asOf: yesterday });
      expect(past).toMatchObject({ asOf: yesterday, totalBilled: 21000, totalReceived: 0, totalOutstanding: 21000, pendingBills: 2 });
      expect(agingPaise(past.aging)).toBe(toPaise(21000));
      const pastBills = await get<{ rows: any[] }>('/bills', { ...scope, status: 'ALL', asOf: yesterday, limit: '100' });
      expect(pastBills.rows.find((r) => r.id === xb.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 20000, paymentStatus: 'UNPAID' });
      const pastDetail = await get('/customers/' + x, { ...scope, asOf: yesterday });
      expect(pastDetail.customer).toMatchObject({ totalPaid: 0, totalOutstanding: 20000 });
      expect(pastDetail.receipts).toEqual([]);
    });
  });

  /* ------------------------------------------------ receipt detail / list -- */

  describe('the receipt shows where its advance went', () => {
    it('detail lists applications with bill numbers; the list finds the receipt by the applied bill', async () => {
      const m = { ...mA, bookId: await newBook(A.tenantId) };
      const mobile = newMobile();
      const r = await advance(A.token, m, mobile, 5000);
      const b = await bill(A.token, m, mobile, 8000);
      await applyOk(A.token, b.id, 5000);

      const rec = await receiptOf(A.token, r.id);
      expect(rec.applications).toEqual([expect.objectContaining({ billId: b.id, bookNumber: b.bookNumber, billNumber: b.billNumber, amount: 5000, status: 'ACTIVE', appliedOn: today })]);
      expect(rec.billNumbers).toBe(`${b.bookNumber}/${b.billNumber}`);

      const list = await req(A.token, 'GET', `/api/receipts?search=${encodeURIComponent(`${b.bookNumber}/${b.billNumber}`)}`);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data.rows.map((x: { id: string }) => x.id)).toEqual([r.id]);
      expect(list.json().data.rows[0]).toMatchObject({ amount: 5000, appliedAmount: 5000, availableAmount: 0 });
    });
  });

  /* ------------------------------------------------ permissions / tenancy -- */

  describe('permissions and tenant isolation', () => {
    it('apply needs receipts create; reverse needs receipts update', async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 1000);
      const b = await bill(A.token, mA, mobile, 1000);

      expect((await apply(A.receiptsRead, b.id, 500)).statusCode).toBe(403);
      expect((await payments(A.token, b.id)).paidAmount).toBe(0);

      await applyOk(A.receiptsCreate, b.id, 500);
      const applicationId = (await receiptOf(A.token, r.id)).applications[0].id;
      expect((await reverse(A.receiptsCreate, applicationId)).statusCode).toBe(403);
      expect((await reverse(A.receiptsRead, applicationId)).statusCode).toBe(403);
      expect((await payments(A.token, b.id)).paidAmount).toBe(500);
    });

    it("tenant B cannot read, apply or reverse tenant A's advance", async () => {
      const mobile = newMobile();
      const r = await advance(A.token, mA, mobile, 2000);
      const b = await bill(A.token, mA, mobile, 2000);
      await applyOk(A.token, b.id, 1000);
      const applicationId = (await receiptOf(A.token, r.id)).applications[0].id;

      expect(await advanceOf(B.token, mobile)).toMatchObject({ availableAdvance: 0, receipts: [] });
      expect((await req(B.token, 'GET', `/api/receipts/${r.id}`)).statusCode).toBe(404);
      expect((await apply(B.token, b.id, 500)).statusCode).toBe(404);
      expect((await reverse(B.token, applicationId)).statusCode).toBe(404);
      expect((await req(B.token, 'GET', `/api/bills/${b.id}/payments`)).statusCode).toBe(404);

      // Tenant B's own customer with the SAME mobile has nothing of A's.
      const bb = await bill(B.token, mB, mobile, 2000);
      expect(await payments(B.token, bb.id)).toMatchObject({ availableAdvance: 0, advanceToApply: 0 });
      expect((await apply(B.token, bb.id, 500)).statusCode).toBe(400);

      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 1000, availableAdvance: 1000 });
    });
  });

  /* ------------------------------------------- advance entered on a new bill -- */

  describe('advance entered while creating the bill', () => {
    const create = (token: string, mobile: string, total: number, extra: Record<string, unknown>) =>
      req(token, 'POST', '/api/bills', {
        bookId: mA.bookId,
        billDate: day0,
        customerName: 'Direct Advance',
        mobileNumber: mobile,
        taxMode: 'WITHOUT_GST',
        items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate: total }],
        ...extra,
      });
    const cash = (amount: number) => ({ amount, paymentMode: 'CASH', accountId: mA.cash.id });
    const receiptsFor = async (mobile: string) => db.select().from(schema.receipts).where(and(eq(schema.receipts.tenantId, A.tenantId), eq(schema.receipts.mobileSearch, mobile)));
    const billsFor = async (mobile: string) => db.select().from(schema.bills).where(and(eq(schema.bills.tenantId, A.tenantId), eq(schema.bills.mobileSearch, mobile)));
    const counterOf = async () => (await db.select().from(schema.books).where(eq(schema.books.id, mA.bookId)))[0].nextBillNumber;

    it('₹20,000 bill + ₹5,000 cash: Grand Total stays 20,000, Paid 5,000, Due 15,000 — one real, numbered receipt', async () => {
      const mobile = newMobile();
      const before = await advance(A.token, mA, newMobile(), 1); // the receipt number just before
      const res = await create(A.token, mobile, 20000, { advance: cash(5000), requestId: crypto.randomUUID() });
      expect(res.statusCode, res.body).toBe(200);
      const b = res.json().data as Bill & { subTotal: number; discountAmount: number; gstAmount: number };
      expect(b).toMatchObject({ grandTotal: 20000, subTotal: 20000, discountAmount: 0, gstAmount: 0 });
      expect(await payments(A.token, b.id)).toMatchObject({ grandTotal: 20000, paidAmount: 5000, outstandingAmount: 15000, paymentStatus: 'PARTIALLY_PAID', availableAdvance: 0 });

      const rs = await receiptsFor(mobile);
      expect(rs).toHaveLength(1);
      expect(rs[0]).toMatchObject({ receiptNumber: before.receiptNumber + 1, receiptDate: day0, paymentMode: 'CASH', accountId: mA.cash.id, amount: '5000.00', status: 'ACTIVE', customerName: 'Direct Advance' });
      const allocations = await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.receiptId, rs[0].id));
      expect(allocations.map((a) => [a.billId, a.amount])).toEqual([[b.id, '5000.00']]);
      // Audited like any receipt, never exposing the mobile.
      const log = await db.select().from(schema.activityLogs).where(and(eq(schema.activityLogs.tenantId, A.tenantId), eq(schema.activityLogs.entityId, rs[0].id)));
      expect(log.map((l) => l.action)).toEqual(['receipt_created']);
      expect(JSON.stringify(log)).not.toContain(mobile);
    });

    it('more than the bill: the bill is paid in full and the rest is the customer’s advance', async () => {
      const mobile = newMobile();
      const b = (await create(A.token, mobile, 3000, { advance: cash(5000) })).json().data as Bill;
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 3000, outstandingAmount: 0, paymentStatus: 'PAID', availableAdvance: 2000 });
      expect(await advanceOf(A.token, mobile)).toMatchObject({ availableAdvance: 2000 });
    });

    it('no advance (absent, null): a normal bill, no receipt, no payment field needed', async () => {
      const m1 = newMobile();
      const m2 = newMobile();
      expect((await create(A.token, m1, 1000, {})).statusCode).toBe(200);
      expect((await create(A.token, m2, 1000, { advance: null })).statusCode).toBe(200);
      expect(await receiptsFor(m1)).toHaveLength(0);
      expect(await receiptsFor(m2)).toHaveLength(0);
      // 0 is not "no advance" but a refused amount — the form sends null for a blank box.
      const zero = await create(A.token, newMobile(), 1000, { advance: cash(0) });
      expect(zero.statusCode).toBe(400);
    });

    it('a refused advance (wrong account for the mode, bad amount) saves nothing — no bill, no receipt, no number burned', async () => {
      const mobile = newMobile();
      const counter = await counterOf();
      const wrongMode = await create(A.token, mobile, 1000, { advance: { amount: 500, paymentMode: 'BANK', accountId: mA.cash.id }, requestId: crypto.randomUUID() });
      expect(wrongMode.statusCode).toBe(400);
      expect(wrongMode.json().error.details?.[0]?.path?.[0]).toBe('advance');
      const otherTenant = await create(A.token, mobile, 1000, { advance: { amount: 500, paymentMode: 'CASH', accountId: mB.cash.id } });
      expect(otherTenant.statusCode).toBe(400);
      const threeDecimals = await create(A.token, mobile, 1000, { advance: cash(10.555) });
      expect(threeDecimals.statusCode).toBe(400);
      expect(await billsFor(mobile)).toHaveLength(0);
      expect(await receiptsFor(mobile)).toHaveLength(0);
      expect(await counterOf()).toBe(counter);
    });


    it('a zero-total bill takes nothing: the whole advance is kept as the customer’s advance', async () => {
      const mobile = newMobile();
      const b = (await create(A.token, mobile, 0, { advance: cash(700) })).json().data as Bill;
      expect(b.grandTotal).toBe(0);
      const [r] = await receiptsFor(mobile);
      expect(await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.receiptId, r.id))).toHaveLength(0);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 0, availableAdvance: 700 });
    });

    it('a refused advance also takes back the Next Visit appointment it would have made', async () => {
      const mobile = newMobile();
      const counters = async () => db.select().from(schema.documentCounters).where(eq(schema.documentCounters.tenantId, A.tenantId));
      const before = JSON.stringify(await counters());
      const refused = await create(A.token, mobile, 1000, { nextVisitDate: addDays(day0, 30), advance: { amount: 500, paymentMode: 'BANK', accountId: mA.cash.id } });
      expect(refused.statusCode).toBe(400);
      expect(await db.select().from(schema.appointments).where(and(eq(schema.appointments.tenantId, A.tenantId), eq(schema.appointments.mobileSearch, mobile)))).toHaveLength(0);
      expect(JSON.stringify(await counters())).toBe(before);
      expect(await billsFor(mobile)).toHaveLength(0);
    });

    it('the same request racing on two DIFFERENT books still makes one bill (the unique-key backstop)', async () => {
      const otherBook = await newBook(A.tenantId);
      const mobile = newMobile();
      const requestId = crypto.randomUUID();
      const payload = (bookId: string) => ({ bookId, advance: cash(100), requestId });
      // Same content except the book — so the loser is a replay of a DIFFERENT request: refused, never a second bill.
      const [x, y] = await Promise.all([create(A.token, mobile, 1000, payload(mA.bookId)), create(A.token, mobile, 1000, payload(otherBook))]);
      expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
      expect(await billsFor(mobile)).toHaveLength(1);
      expect(await receiptsFor(mobile)).toHaveLength(1);
    });

    it('a retry with CHANGED content is refused (409), never answered with the first bill as if it were the new one', async () => {
      const mobile = newMobile();
      const requestId = crypto.randomUUID();
      const first = await create(A.token, mobile, 5000, { advance: cash(1000), requestId });
      expect(first.statusCode).toBe(200);
      const changed = await create(A.token, mobile, 5000, { advance: { amount: 1000, paymentMode: 'CASH', accountId: mA.cash.id }, requestId, remark: 'changed after a lost response' });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('BILL_ALREADY_SAVED');
      expect(changed.json().error.message).toContain(`Bill No. ${first.json().data.billNumber}`);
      expect(await billsFor(mobile)).toHaveLength(1);
      expect(await receiptsFor(mobile)).toHaveLength(1);
      // Neither the request id nor its fingerprint is ever in a response.
      expect(first.json().data).not.toHaveProperty('createRequestId');
      expect(first.json().data).not.toHaveProperty('createRequestHash');
    });

    it('a retry, a double submit and concurrent submits of ONE request make one bill and one receipt', async () => {
      const mobile = newMobile();
      const requestId = crypto.randomUUID();
      const body = { advance: cash(2500), requestId };
      const first = await create(A.token, mobile, 10000, body);
      expect(first.statusCode, first.body).toBe(200);
      const retry = await create(A.token, mobile, 10000, body);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().data.id).toBe(first.json().data.id);
      expect(retry.json().message).toMatch(/already saved/);

      const racing = crypto.randomUUID();
      const mobile2 = newMobile();
      const all = await Promise.all(Array.from({ length: 6 }, () => create(A.token, mobile2, 10000, { advance: cash(2500), requestId: racing })));
      expect(all.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(all.map((r) => r.json().data.id)).size).toBe(1);

      for (const m of [mobile, mobile2]) {
        expect(await billsFor(m)).toHaveLength(1);
        const rs = await receiptsFor(m);
        expect(rs).toHaveLength(1);
        expect(await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.receiptId, rs[0].id))).toHaveLength(1);
      }
      expect(await payments(A.token, first.json().data.id)).toMatchObject({ paidAmount: 2500, outstandingAmount: 7500 });
      // A different request is a different bill.
      expect((await create(A.token, mobile, 10000, { requestId: crypto.randomUUID() })).json().data.id).not.toBe(first.json().data.id);
    });

    it('editing the bill never re-creates or changes the advance — money moves only through receipts', async () => {
      const mobile = newMobile();
      const b = (await create(A.token, mobile, 8000, { advance: cash(3000), requestId: crypto.randomUUID() })).json().data as Bill;
      const edit = (extra: Record<string, unknown>) =>
        req(A.token, 'PUT', `/api/bills/${b.id}`, { billDate: day0, customerName: 'Direct Advance', mobileNumber: mobile, taxMode: 'WITHOUT_GST', items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate: 8000 }], ...extra });
      expect((await edit({})).statusCode).toBe(200);
      // An edit carrying an advance (or trying to lower it) is ignored by the update schema.
      expect((await edit({ advance: cash(2000) })).statusCode).toBe(200);
      expect((await edit({ advance: cash(9999) })).statusCode).toBe(200);
      expect(await receiptsFor(mobile)).toHaveLength(1);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 3000, outstandingAmount: 5000 });

      // Correction is the receipt's: cancel it and the bill owes the whole again. The bill stays undeletable.
      const [r] = await receiptsFor(mobile);
      expect((await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'entered by mistake' })).statusCode).toBe(200);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 8000 });
      expect((await req(A.token, 'DELETE', `/api/bills/${b.id}`)).statusCode).toBe(409);
    });

    it('needs Receipts Create as well as Billing Create; without it nothing is saved', async () => {
      const billingOnly = await seedUser(A.tenantId, 'adv-billing-only', { operations_billing: ['read', 'create'] });
      const mobile = newMobile();
      const refused = await create(billingOnly, mobile, 1000, { advance: cash(500) });
      expect(refused.statusCode).toBe(403);
      expect(await billsFor(mobile)).toHaveLength(0);
      // The same user can still save the bill itself.
      expect((await create(billingOnly, mobile, 1000, {})).statusCode).toBe(200);
      expect(await receiptsFor(mobile)).toHaveLength(0);
    });

    it('earlier advance is not consumed by creating a bill — it waits for an explicit Apply', async () => {
      const mobile = newMobile();
      await advance(A.token, mA, mobile, 4000);
      const b = (await create(A.token, mobile, 10000, { advance: cash(1000) })).json().data as Bill;
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 1000, outstandingAmount: 9000, availableAdvance: 4000, advanceToApply: 4000 });
      await applyOk(A.token, b.id, 4000);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 5000, availableAdvance: 0 });
    });
  });
});
