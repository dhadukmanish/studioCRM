import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { billPaymentStatus, paymentModeForGroup, receiptSchema, toPaise, fromPaise } from '@erp/shared';

/**
 * Receipts, bill allocation and outstanding (Phase 6, docs/RECEIPTS_PAYMENTS.md).
 *
 * Section A always runs: the receipt payload, the derived payment status, the Cash/Bank
 * classification and exact paise arithmetic.
 *
 * Section B needs TEST_DATABASE_URL (a THROWAWAY database): partial / multi-bill / multiple
 * receipts, overpayment (sequential and concurrent), deterministic locking, cancellation, the
 * bill edit and delete guards, tenant isolation, account validation, credit, numbering, RBAC,
 * audit, the lists, and that a receipt never revokes a bill's public invoice link.
 */

const uuid = '00000000-0000-4000-8000-000000000001';
const valid = { receiptDate: '2026-09-25', customerMobile: '98765 43210', paymentMode: 'CASH', accountId: uuid, amount: 100, allocations: [{ billId: uuid, amount: 100 }] };

/* ------------------------------------------------ A. pure behaviour -- */

describe('receiptSchema', () => {
  it('accepts a receipt whose amount equals its allocations', () => {
    expect(receiptSchema.safeParse(valid).success).toBe(true);
    const multi = { ...valid, amount: 12000, allocations: [{ billId: uuid, amount: 10000 }, { billId: '00000000-0000-4000-8000-000000000002', amount: 2000 }] };
    expect(receiptSchema.safeParse(multi).success).toBe(true);
  });

  // Phase "studio workflow" changed this rule on purpose: money beyond the allocations is ADVANCE
  // (docs/ADVANCE_PAYMENTS.md). More allocated than received is still refused, to the paisa.
  it('keeps money beyond the allocations as advance, but refuses more allocated than received', () => {
    expect(receiptSchema.safeParse({ ...valid, amount: 120 }).success).toBe(true);
    expect(receiptSchema.safeParse({ ...valid, amount: 99.99 }).success).toBe(false);
  });

  it('compares exactly to the paisa (no float drift)', () => {
    const body = { ...valid, amount: 0.3, allocations: [{ billId: uuid, amount: 0.1 }, { billId: '00000000-0000-4000-8000-000000000002', amount: 0.2 }] };
    expect(receiptSchema.safeParse(body).success).toBe(true);
  });

  it('refuses zero, negative and 3-decimal amounts, on the receipt and on an allocation', () => {
    for (const amount of [0, -5, 10.001]) {
      expect(receiptSchema.safeParse({ ...valid, amount, allocations: [{ billId: uuid, amount }] }).success).toBe(false);
    }
    expect(receiptSchema.safeParse({ ...valid, amount: 100, allocations: [{ billId: uuid, amount: 100 }, { billId: '00000000-0000-4000-8000-000000000002', amount: 0 }] }).success).toBe(false);
  });

  it('refuses the same bill twice and CREDIT as a payment mode; no allocation at all is a whole-receipt advance', () => {
    expect(receiptSchema.safeParse({ ...valid, amount: 200, allocations: [{ billId: uuid, amount: 100 }, { billId: uuid, amount: 100 }] }).success).toBe(false);
    expect(receiptSchema.safeParse({ ...valid, allocations: [] }).success).toBe(true);
    expect(receiptSchema.safeParse({ ...valid, paymentMode: 'CREDIT' }).success).toBe(false);
  });

  // The customer name is accepted only for a customer with no bill yet; the server ignores it
  // otherwise (see "names the customer from their bill" below).
  it('never takes a receipt number or outstanding from the client', () => {
    const parsed = receiptSchema.parse({ ...valid, receiptNumber: 99, outstanding: 5 }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('receiptNumber');
    expect(parsed).not.toHaveProperty('outstanding');
  });
});

describe('billPaymentStatus (derived, never stored)', () => {
  it('is UNPAID, PARTIALLY_PAID or PAID from Paid against the Grand Total', () => {
    expect(billPaymentStatus(10000, 0)).toBe('UNPAID');
    expect(billPaymentStatus(10000, 3000)).toBe('PARTIALLY_PAID');
    expect(billPaymentStatus(10000, 9999.99)).toBe('PARTIALLY_PAID');
    expect(billPaymentStatus(10000, 10000)).toBe('PAID');
    expect(billPaymentStatus(0, 0)).toBe('PAID');
  });
});

describe('paymentModeForGroup (Account Master classification, never an account name)', () => {
  it('BANK is the group that drives bank details; CASH is the CASH head group or a group named CASH', () => {
    expect(paymentModeForGroup({ groupName: 'BANK', headGroup: 'ASSETS' })).toBe('BANK');
    expect(paymentModeForGroup({ groupName: ' bank ', headGroup: 'ASSETS' })).toBe('BANK');
    expect(paymentModeForGroup({ groupName: 'CASH', headGroup: 'CASH' })).toBe('CASH');
    expect(paymentModeForGroup({ groupName: 'Petty Cash', headGroup: 'CASH' })).toBe('CASH');
  });

  it('nothing else is a payment account', () => {
    for (const groupName of ['CLIENT', 'EMPLOYEE', 'LOAN', 'PARTNER', 'EXPENSES', 'EXPOSER/PARTY', 'Cash Customers']) {
      expect(paymentModeForGroup({ groupName, headGroup: groupName === 'EXPENSES' ? 'EXPENSES' : 'ASSETS' }), groupName).toBeNull();
    }
  });
});

describe('paise', () => {
  it('round-trips 2-decimal rupees exactly', () => {
    expect(toPaise(0.1) + toPaise(0.2)).toBe(toPaise(0.3));
    expect(toPaise('999999999999.99')).toBe(99999999999999);
    expect(fromPaise(toPaise(1234.56))).toBe(1234.56);
  });
});

/* ------------------------------------------- B. against a database -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Receipts API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let and: typeof import('drizzle-orm').and;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;
  let isNull: typeof import('drizzle-orm').isNull;

  const tenantIds: string[] = [];
  const FULL = { operations_billing: ['read', 'create', 'update', 'delete'], operations_receipts: ['read', 'create', 'update'] };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const req = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });

  /* ---------------------------------------------------------- fixtures -- */

  async function seedTenant(name: string, grants: Record<string, string[]> = FULL) {
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    return { tenantId: tenant.id, token: await seedUser(tenant.id, name, grants) };
  }
  async function seedUser(tenantId: string, name: string, grants: Record<string, string[]>) {
    const [role] = await db.insert(schema.roles).values({ tenantId, name: `${name} role ${Math.random().toString(36).slice(2, 6)}`, permissions: grants }).returning();
    const [user] = await db
      .insert(schema.users)
      .values({ tenantId, roleId: role.id, firstName: name, lastName: 'Tester', email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: 'not-a-real-hash' })
      .returning();
    return app.jwt.sign({ sub: user.id, tenantId });
  }

  /** Per tenant: a book, a 0% product and the payment/non-payment accounts the tests pick from. */
  async function seedMasters(tenantId: string) {
    const [book] = await db.insert(schema.books).values({ tenantId, bookNumber: `RB${Math.random().toString(36).slice(2, 7)}`, seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId, itemName: `Item-${Math.random().toString(36).slice(2, 8)}`, hsnCode: '9983', gstRate: '0.00' }).returning();
    const [subItem] = await db.insert(schema.subItems).values({ tenantId, itemId: item.id, productName: `Prod-${Math.random().toString(36).slice(2, 8)}`, rate: '100.00' }).returning();
    const group = async (groupName: string, headGroup: string) => (await db.insert(schema.accountGroups).values({ tenantId, groupName, headGroup }).returning())[0];
    const account = async (groupId: string, accountName: string, isActive = true) =>
      (await db.insert(schema.accounts).values({ tenantId, accountGroupId: groupId, accountName, isActive }).returning())[0];
    const cashG = await group('CASH', 'CASH');
    const bankG = await group('BANK', 'ASSETS');
    const empG = await group('EMPLOYEE', 'EXPENSES');
    const clientG = await group('CLIENT', 'ASSETS');
    return {
      book,
      item,
      subItem,
      cash: await account(cashG.id, 'CASH IN HAND'),
      oldCash: await account(cashG.id, 'OLD CASH BOX', false),
      bank: await account(bankG.id, 'HDFC CURRENT'),
      employee: await account(empG.id, 'RAVI (EMPLOYEE)'),
      client: await account(clientG.id, 'WALK-IN CLIENT'),
    };
  }
  type Masters = Awaited<ReturnType<typeof seedMasters>>;

  /** A fresh 10-digit mobile per customer, so tests never see each other's bills. */
  const newMobile = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

  /** A WITHOUT_GST bill whose Grand Total is exactly `total`. */
  async function bill(token: string, m: Masters, mobile: string, total: number, overrides: Record<string, unknown> = {}) {
    const res = await req(token, 'POST', '/api/bills', {
      bookId: m.book.id,
      billDate: '2026-09-20',
      customerName: 'Receipt Customer',
      mobileNumber: mobile,
      taxMode: 'WITHOUT_GST',
      items: [{ itemId: m.item.id, subItemId: m.subItem.id, quantity: 1, rate: total }],
      ...overrides,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; billNumber: number; grandTotal: number; bookNumber: string; mobileSearch: string };
  }

  const receiptBody = (m: Masters, mobile: string, allocations: { billId: string; amount: number }[], overrides: Record<string, unknown> = {}) => ({
    receiptDate: '2026-09-25',
    customerMobile: mobile,
    paymentMode: 'CASH',
    accountId: m.cash.id,
    amount: fromPaise(allocations.reduce((s, a) => s + toPaise(a.amount), 0)),
    allocations,
    ...overrides,
  });
  const receipt = (token: string, m: Masters, mobile: string, allocations: { billId: string; amount: number }[], overrides: Record<string, unknown> = {}) =>
    req(token, 'POST', '/api/receipts', receiptBody(m, mobile, allocations, overrides));
  const receiptOk = async (token: string, m: Masters, mobile: string, allocations: { billId: string; amount: number }[], overrides: Record<string, unknown> = {}) => {
    const res = await receipt(token, m, mobile, allocations, overrides);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; receiptNumber: number; amount: number; status: string; customerName: string; allocations: { billId: string; amount: number; paidAmount: number; outstandingAmount: number }[] };
  };
  const payments = async (token: string, billId: string) => (await req(token, 'GET', `/api/bills/${billId}/payments`)).json().data as {
    grandTotal: number;
    paidAmount: number;
    outstandingAmount: number;
    paymentStatus: string;
    history: { receiptNumber: number; amount: number; status: string }[];
  };
  const receiptCount = async (tenantId: string) => (await db.select().from(schema.receipts).where(eq(schema.receipts.tenantId, tenantId))).length;
  const allocationCount = async (tenantId: string) => (await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.tenantId, tenantId))).length;
  const counterOf = async (tenantId: string, documentType: string) =>
    (await db.select().from(schema.documentCounters).where(and(eq(schema.documentCounters.tenantId, tenantId), eq(schema.documentCounters.documentType, documentType))))[0]?.nextNumber ?? null;
  const nextBillNumberOf = async (bookId: string) => (await db.select().from(schema.books).where(eq(schema.books.id, bookId)))[0].nextBillNumber;

  /* ------------------------------------------------------------- state -- */

  let A = { tenantId: '', token: '', readOnly: '', billingOnly: '' };
  let mA: Masters;
  let B = { tenantId: '', token: '' };
  let mB: Masters;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ and, eq, inArray, isNull } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('rcpt-tenant-a');
    A = {
      ...a,
      readOnly: await seedUser(a.tenantId, 'rcpt-readonly', { operations_billing: ['read'], operations_receipts: ['read'] }),
      billingOnly: await seedUser(a.tenantId, 'rcpt-billing-only', { operations_billing: ['read', 'create', 'update', 'delete'] }),
    };
    mA = await seedMasters(A.tenantId);
    B = await seedTenant('rcpt-tenant-b');
    mB = await seedMasters(B.tenantId);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      const t = tenantIds;
      await db.delete(schema.receiptAllocations).where(inArray(schema.receiptAllocations.tenantId, t));
      await db.delete(schema.receipts).where(inArray(schema.receipts.tenantId, t));
      await db.delete(schema.publicInvoiceLinks).where(inArray(schema.publicInvoiceLinks.tenantId, t));
      await db.delete(schema.billItems).where(inArray(schema.billItems.tenantId, t));
      await db.delete(schema.bills).where(inArray(schema.bills.tenantId, t));
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

  /* ------------------------------------------------------------ core flows -- */

  describe('partial and full payment', () => {
    it('₹10,000 bill: ₹3,000 -> partially paid, then ₹7,000 -> paid', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      expect(await payments(A.token, b.id)).toMatchObject({ grandTotal: 10000, paidAmount: 0, outstandingAmount: 10000, paymentStatus: 'UNPAID', history: [] });

      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 3000 }]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 3000, outstandingAmount: 7000, paymentStatus: 'PARTIALLY_PAID' });

      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 7000 }]);
      const p = await payments(A.token, b.id);
      expect(p).toMatchObject({ paidAmount: 10000, outstandingAmount: 0, paymentStatus: 'PAID' });
      expect(p.history.map((h) => h.amount)).toEqual([3000, 7000]);
    });

    it('one bill, two receipts (₹3,000 + ₹2,000) -> paid ₹5,000, outstanding ₹5,000', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 3000 }]);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 2000 }], { paymentMode: 'BANK', accountId: mA.bank.id });
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 5000, paymentStatus: 'PARTIALLY_PAID' });
    });

    it('one receipt of ₹12,000 across bills of ₹10,000 / ₹5,000 / ₹8,000', async () => {
      const mobile = newMobile();
      const [b10, b11, b12] = [await bill(A.token, mA, mobile, 10000), await bill(A.token, mA, mobile, 5000), await bill(A.token, mA, mobile, 8000)];
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b10.id, amount: 10000 }, { billId: b11.id, amount: 2000 }]);
      expect(r.amount).toBe(12000);
      expect(r.allocations).toHaveLength(2);
      expect(await payments(A.token, b10.id)).toMatchObject({ outstandingAmount: 0, paymentStatus: 'PAID' });
      expect(await payments(A.token, b11.id)).toMatchObject({ paidAmount: 2000, outstandingAmount: 3000, paymentStatus: 'PARTIALLY_PAID' });
      expect(await payments(A.token, b12.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 8000, paymentStatus: 'UNPAID' });
      const [stored] = await db.select().from(schema.receipts).where(eq(schema.receipts.id, r.id));
      expect(stored.amount).toBe('12000.00');
    });

    it('stores the customer from the server (latest bill), not from the payload', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 500, { customerName: 'Meera Shah' });
      const r = await receiptOk(A.token, mA, `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`, [{ billId: b.id, amount: 500 }], { customerName: 'Somebody Else' });
      expect(r.customerName).toBe('Meera Shah');
    });
  });

  /* ---------------------------------------------------------- refusals -- */

  describe('refusals leave no trace', () => {
    it('₹3,001 against ₹3,000 outstanding: refused; no receipt, no allocation, no number used', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 7000 }]);
      const before = { receipts: await receiptCount(A.tenantId), allocations: await allocationCount(A.tenantId), counter: await counterOf(A.tenantId, 'receipt') };

      const res = await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 3000.01 }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toEqual(['allocations', 0, 'amount']);
      expect(res.json().error.message).toMatch(/3000\.00 outstanding/);
      expect({ receipts: await receiptCount(A.tenantId), allocations: await allocationCount(A.tenantId), counter: await counterOf(A.tenantId, 'receipt') }).toEqual(before);

      // Exactly the outstanding is fine, and takes the very next number.
      const ok = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 3000 }]);
      expect(ok.receiptNumber).toBe(before.counter);
    });

    it('a fully paid bill cannot take more', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 100);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }]);
      const res = await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 1 }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/already fully paid/);
    });

    it('a receipt amount below its allocations is refused (above them, the rest is advance — see advance.test.ts)', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 12000);
      const res = await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 10000 }], { amount: 9000 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.some((d: { path: string[] }) => d.path[0] === 'amount')).toBe(true);
    });

    it("never lets customer A's receipt settle customer B's bill", async () => {
      const a = newMobile();
      const b = newMobile();
      const billA = await bill(A.token, mA, a, 1000);
      const billB = await bill(A.token, mA, b, 1000);
      const before = await receiptCount(A.tenantId);
      const res = await receipt(A.token, mA, a, [{ billId: billA.id, amount: 500 }, { billId: billB.id, amount: 500 }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0]).toMatchObject({ path: ['allocations', 1, 'billId'] });
      expect(res.json().error.message).toMatch(/another customer/);
      expect(await receiptCount(A.tenantId)).toBe(before);
      expect((await payments(A.token, billA.id)).paidAmount).toBe(0);
    });

    it('a receipt dated before any bill it settles is refused; the bill date itself is fine', async () => {
      const mobile = newMobile();
      const early = await bill(A.token, mA, mobile, 1000, { billDate: '2026-09-01' });
      const late = await bill(A.token, mA, mobile, 1000, { billDate: '2026-09-20' });
      const before = { receipts: await receiptCount(A.tenantId), counter: await counterOf(A.tenantId, 'receipt') };
      const res = await receipt(A.token, mA, mobile, [{ billId: early.id, amount: 100 }, { billId: late.id, amount: 100 }], { receiptDate: '2026-09-19' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.map((d: { path: unknown[] }) => d.path)).toEqual([['receiptDate'], ['allocations', 1, 'billId']]);
      expect({ receipts: await receiptCount(A.tenantId), counter: await counterOf(A.tenantId, 'receipt') }).toEqual(before);
      await receiptOk(A.token, mA, mobile, [{ billId: early.id, amount: 100 }, { billId: late.id, amount: 100 }], { receiptDate: '2026-09-20' });
    });

    it('an unknown bill is refused', async () => {
      const res = await receipt(A.token, mA, newMobile(), [{ billId: '00000000-0000-4000-8000-00000000abcd', amount: 10 }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/does not exist/);
    });
  });

  /* ------------------------------------------------------- concurrency -- */

  describe('concurrency', () => {
    it('two ₹4,000 receipts racing for ₹5,000 outstanding: exactly one commits', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 5000);
      const results = await Promise.all([receipt(A.token, mA, mobile, [{ billId: b.id, amount: 4000 }]), receipt(A.token, mA, mobile, [{ billId: b.id, amount: 4000 }])]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 4000, outstandingAmount: 1000 });
    });

    it('many receipts over overlapping bills, locked in any request order: no deadlock, no overpayment', async () => {
      const mobile = newMobile();
      const bills = [await bill(A.token, mA, mobile, 1000), await bill(A.token, mA, mobile, 1000), await bill(A.token, mA, mobile, 1000)];
      // 15 receipts, each ₹50 to two or three of the bills, in rotating (reversed / shuffled) request
      // orders — 39 allocations, at most 15 per bill, so every one fits and every one must commit.
      const orders = [[0, 1, 2], [2, 1, 0], [1, 2], [2, 0], [1, 0, 2]];
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) => receipt(A.token, mA, mobile, orders[i % orders.length].map((k) => ({ billId: bills[k].id, amount: 50 })))),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(15).fill(200));
      const paid = await Promise.all(bills.map((b) => payments(A.token, b.id)));
      expect(paid.map((p) => p.paidAmount)).toEqual([600, 600, 750]);
      expect(paid.every((p) => p.paidAmount <= p.grandTotal)).toBe(true);
    });

    it('racing receipts that would jointly overpay: the bill stops exactly at its Grand Total', async () => {
      const mobile = newMobile();
      const x = await bill(A.token, mA, mobile, 1000);
      const y = await bill(A.token, mA, mobile, 1000);
      const results = await Promise.all(
        Array.from({ length: 14 }, (_, i) => receipt(A.token, mA, mobile, (i % 2 ? [x, y] : [y, x]).map((b) => ({ billId: b.id, amount: 100 })))),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
      expect(results.filter((r) => r.statusCode === 400)).toHaveLength(4);
      expect(results.some((r) => r.statusCode >= 500)).toBe(false);
      expect((await payments(A.token, x.id)).paidAmount).toBe(1000);
      expect((await payments(A.token, y.id)).paidAmount).toBe(1000);
    });

    it('a receipt racing a bill edit that lowers the total: the database never ends overpaid', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const shrink = req(A.token, 'PUT', `/api/bills/${b.id}`, {
        billDate: '2026-09-20',
        customerName: 'Receipt Customer',
        mobileNumber: mobile,
        taxMode: 'WITHOUT_GST',
        items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate: 500 }],
      });
      const pay = receipt(A.token, mA, mobile, [{ billId: b.id, amount: 800 }]);
      const [e, r] = await Promise.all([shrink, pay]);
      expect([e.statusCode, r.statusCode].sort()).toEqual([200, 400]);
      const p = await payments(A.token, b.id);
      expect(p.paidAmount).toBeLessThanOrEqual(p.grandTotal);
    });
  });

  /* ------------------------------------------------------------ cancel -- */

  describe('cancelling a receipt', () => {
    it('gives the money back to outstanding and keeps the receipt in history as CANCELLED', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 4000 }]);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 4000, outstandingAmount: 6000 });

      const res = await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'Wrong customer' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong customer' });
      expect(res.json().data.cancelledAt).toBeTruthy();

      const p = await payments(A.token, b.id);
      expect(p).toMatchObject({ paidAmount: 0, outstandingAmount: 10000, paymentStatus: 'UNPAID' });
      expect(p.history).toEqual([expect.objectContaining({ receiptNumber: r.receiptNumber, amount: 4000, status: 'CANCELLED' })]);
      // Row and allocation are still there.
      expect(await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.receiptId, r.id))).toHaveLength(1);
      const list = (await req(A.token, 'GET', `/api/receipts?search=${r.receiptNumber}`)).json().data.rows;
      expect(list.find((x: { id: string }) => x.id === r.id)).toMatchObject({ status: 'CANCELLED' });
    });

    it('a second cancel is refused (409) and changes nothing', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 1000 }]);
      expect((await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {})).statusCode).toBe(200);
      const again = await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'twice' });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('RECEIPT_ALREADY_CANCELLED');
      const [row] = await db.select().from(schema.receipts).where(eq(schema.receipts.id, r.id));
      expect(row.cancelReason).toBeNull();
    });

    it('after a cancel the bill can be paid again, up to its total', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 1000 }]);
      await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {});
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 1000 }]);
      expect((await payments(A.token, b.id)).paymentStatus).toBe('PAID');
    });
  });

  /* ------------------------------------------------- bill edit / delete -- */

  describe('a bill with payments', () => {
    const edit = (billId: string, mobile: string, rate: number, overrides: Record<string, unknown> = {}) =>
      req(A.token, 'PUT', `/api/bills/${billId}`, {
        billDate: '2026-09-20',
        customerName: 'Receipt Customer',
        mobileNumber: mobile,
        taxMode: 'WITHOUT_GST',
        items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate }],
        ...overrides,
      });

    it('cannot be edited below what was already paid; exactly the paid amount is allowed', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 10000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 7000 }]);

      const refused = await edit(b.id, mobile, 6000);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toMatch(/7000\.00 has already been received/);
      expect((await payments(A.token, b.id)).grandTotal).toBe(10000);

      const allowed = await edit(b.id, mobile, 7000);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(await payments(A.token, b.id)).toMatchObject({ grandTotal: 7000, paidAmount: 7000, outstandingAmount: 0, paymentStatus: 'PAID' });
    });

    it('cannot move to another customer mobile, but the name can be corrected', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }]);
      const moved = await edit(b.id, newMobile(), 1000);
      expect(moved.statusCode).toBe(400);
      expect(moved.json().error.details[0].path).toEqual(['mobileNumber']);
      expect((await edit(b.id, mobile, 1000, { customerName: 'Corrected Name' })).statusCode).toBe(200);
    });

    it('with only a cancelled receipt: the total is free again, but the mobile still cannot change', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 900 }]);
      await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {});
      expect((await edit(b.id, mobile, 10)).statusCode).toBe(200);
      const moved = await edit(b.id, newMobile(), 10);
      expect(moved.statusCode).toBe(400);
      expect(moved.json().error.details[0].path).toEqual(['mobileNumber']);
      expect(moved.json().error.message).toMatch(/receipt history/);
    });

    /**
     * A bill saved before the ten-digit rule, with receipt history: its stored mobile fails the new
     * rule and any ten-digit value is another customer — so the untouched key must stay saveable.
     */
    it('a legacy bill with receipts stays editable with its own customer key', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }]);
      // Formatted as it was typed before the rule — same key.
      await db.update(schema.bills).set({ mobileNumber: `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` }).where(eq(schema.bills.id, b.id));
      expect((await edit(b.id, mobile, 1000, { customerName: 'Legacy Corrected' })).statusCode).toBe(200);
      // A short legacy number — its key is itself.
      await db.update(schema.bills).set({ mobileNumber: '98765-4321', mobileSearch: '987654321' }).where(eq(schema.bills.id, b.id));
      expect((await edit(b.id, '987654321', 1000)).statusCode).toBe(200);
      const moved = await edit(b.id, '9876543210', 1000);
      expect(moved.statusCode).toBe(400);
      expect(moved.json().error.message).toMatch(/receipt history/);
    });

    it('with no receipt history, the mobile can change as before', async () => {
      const b = await bill(A.token, mA, newMobile(), 1000);
      expect((await edit(b.id, newMobile(), 1000)).statusCode).toBe(200);
    });

    it('cannot be deleted — even when its only receipt is cancelled; history stays intact', async () => {
      const mobile = newMobile();
      const paid = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: paid.id, amount: 400 }]);
      const res = await req(A.token, 'DELETE', `/api/bills/${paid.id}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BILL_HAS_PAYMENTS');
      expect(await db.select().from(schema.bills).where(eq(schema.bills.id, paid.id))).toHaveLength(1);
      expect(await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.receiptId, r.id))).toHaveLength(1);

      await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {});
      expect((await req(A.token, 'DELETE', `/api/bills/${paid.id}`)).statusCode).toBe(409);

      // A bill nobody has paid is still deletable as before.
      const unpaid = await bill(A.token, mA, mobile, 50);
      expect((await req(A.token, 'DELETE', `/api/bills/${unpaid.id}`)).statusCode).toBe(200);
    });

    it('the database itself refuses to delete a bill with allocations (RESTRICT)', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 1 }]);
      await expect(db.delete(schema.bills).where(eq(schema.bills.id, b.id))).rejects.toThrow();
    });
  });

  /* ------------------------------------------------------------ accounts -- */

  describe('payment accounts', () => {
    it('Cash lists only active cash accounts; Bank only bank accounts', async () => {
      const cash = (await req(A.token, 'GET', '/api/receipts/accounts?mode=CASH')).json().data.map((a: { accountName: string }) => a.accountName);
      const bank = (await req(A.token, 'GET', '/api/receipts/accounts?mode=BANK')).json().data.map((a: { accountName: string }) => a.accountName);
      expect(cash).toEqual(['CASH IN HAND']);
      expect(bank).toEqual(['HDFC CURRENT']);
      expect((await req(A.token, 'GET', '/api/receipts/accounts?mode=CREDIT')).statusCode).toBe(400);
    });

    it('the server re-validates the submitted account against the mode', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const cases: [string, string][] = [
        ['CASH', mA.bank.id],
        ['BANK', mA.cash.id],
        ['BANK', mA.employee.id],
        ['CASH', mA.client.id],
        ['CASH', mA.oldCash.id],
        ['CASH', '00000000-0000-4000-8000-00000000beef'],
      ];
      for (const [paymentMode, accountId] of cases) {
        const res = await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 10 }], { paymentMode, accountId });
        expect(res.statusCode, `${paymentMode} ${accountId}`).toBe(400);
        expect(res.json().error.details[0].path).toEqual(['accountId']);
      }
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0 });
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 10 }], { paymentMode: 'BANK', accountId: mA.bank.id });
    });
  });

  /* -------------------------------------------------------------- credit -- */

  describe('credit', () => {
    it('is not a payment: a credit bill stays UNPAID with no allocation, and CREDIT cannot be posted as a receipt', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 2500);
      expect(await payments(A.token, b.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 2500, paymentStatus: 'UNPAID', history: [] });
      const res = await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 2500 }], { paymentMode: 'CREDIT' });
      expect(res.statusCode).toBe(400);
      expect(await db.select().from(schema.receiptAllocations).where(eq(schema.receiptAllocations.billId, b.id))).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------ numbering -- */

  describe('receipt numbers', () => {
    it('25 parallel receipts get 1..25 exactly once; no bill or appointment counter moves', async () => {
      const t = await seedTenant('rcpt-numbers');
      const m = await seedMasters(t.tenantId);
      const mobile = newMobile();
      const bills = await Promise.all(Array.from({ length: 25 }, () => bill(t.token, m, mobile, 100)));
      const bookNext = await nextBillNumberOf(m.book.id);
      const results = await Promise.all(bills.map((b) => receipt(t.token, m, mobile, [{ billId: b.id, amount: 100 }])));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const numbers = results.map((r) => r.json().data.receiptNumber).sort((x: number, y: number) => x - y);
      expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(await counterOf(t.tenantId, 'receipt')).toBe(26);
      expect(await nextBillNumberOf(m.book.id)).toBe(bookNext);
      expect(await counterOf(t.tenantId, 'appointment')).toBeNull();
    });

    it('a number cannot be sent by the client', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 100);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }], { receiptNumber: 999999 });
      expect(r.receiptNumber).not.toBe(999999);
    });
  });

  /* ----------------------------------------------------- tenant isolation -- */

  describe('tenant isolation', () => {
    it("tenant A cannot settle tenant B's bill, use B's account, or read B's receipts", async () => {
      const mobile = newMobile();
      const billB = await bill(B.token, mB, mobile, 1000);
      const receiptB = await receiptOk(B.token, mB, mobile, [{ billId: billB.id, amount: 100 }]);
      const billA = await bill(A.token, mA, mobile, 1000);

      const foreignBill = await receipt(A.token, mA, mobile, [{ billId: billB.id, amount: 100 }]);
      expect(foreignBill.statusCode).toBe(400);
      expect(foreignBill.json().error.message).toMatch(/does not exist/);

      const foreignAccount = await receipt(A.token, mA, mobile, [{ billId: billA.id, amount: 100 }], { accountId: mB.cash.id });
      expect(foreignAccount.statusCode).toBe(400);
      expect(foreignAccount.json().error.details[0].path).toEqual(['accountId']);

      expect((await req(A.token, 'GET', `/api/receipts/${receiptB.id}`)).statusCode).toBe(404);
      expect((await req(A.token, 'POST', `/api/receipts/${receiptB.id}/cancel`, {})).statusCode).toBe(404);
      expect((await req(A.token, 'GET', `/api/bills/${billB.id}/payments`)).statusCode).toBe(404);
      const listA = (await req(A.token, 'GET', '/api/receipts?limit=500')).json().data.rows;
      expect(listA.some((r: { id: string }) => r.id === receiptB.id)).toBe(false);
      // The same mobile in tenant A sees only tenant A's bill.
      const pending = (await req(A.token, 'GET', `/api/receipts/pending-bills?customer=${mobile}`)).json().data;
      expect(pending.map((p: { id: string }) => p.id)).toEqual([billA.id]);
      expect((await payments(B.token, billB.id)).paidAmount).toBe(100);
    });
  });

  /* ----------------------------------------------------------------- RBAC -- */

  describe('permissions', () => {
    it('read-only may look, not record or cancel; billing-only cannot see receipts', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }]);

      expect((await req(A.readOnly, 'GET', '/api/receipts')).statusCode).toBe(200);
      expect((await req(A.readOnly, 'GET', `/api/receipts/${r.id}`)).statusCode).toBe(200);
      expect((await req(A.readOnly, 'POST', '/api/receipts', receiptBody(mA, mobile, [{ billId: b.id, amount: 1 }]))).statusCode).toBe(403);
      expect((await req(A.readOnly, 'POST', `/api/receipts/${r.id}/cancel`, {})).statusCode).toBe(403);
      expect((await db.select().from(schema.receipts).where(eq(schema.receipts.id, r.id)))[0].status).toBe('ACTIVE');

      expect((await req(A.billingOnly, 'GET', '/api/receipts')).statusCode).toBe(403);
      expect((await req(A.billingOnly, 'GET', '/api/receipts/customers')).statusCode).toBe(403);
      // A bill's own payment position needs only Billing read.
      expect((await req(A.billingOnly, 'GET', `/api/bills/${b.id}/payments`)).statusCode).toBe(200);
    });
  });

  /* ---------------------------------------------------------------- audit -- */

  describe('audit', () => {
    it('logs receipt_created and receipt_cancelled with the receipt and amount — no mobile', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 250 }]);
      await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'duplicate' });
      const logs = await db.select().from(schema.activityLogs).where(and(eq(schema.activityLogs.entityType, 'receipt'), eq(schema.activityLogs.entityId, r.id)));
      expect(logs.map((l) => l.action).sort()).toEqual(['receipt_cancelled', 'receipt_created']);
      for (const l of logs) {
        expect(l.meta).toMatchObject({ receiptNumber: r.receiptNumber, amount: 250 });
        expect(JSON.stringify(l)).not.toContain(mobile);
        expect(l.description).not.toMatch(/deleted/i);
      }
    });
  });

  /* ---------------------------------------------------------------- lists -- */

  describe('lists and lookups', () => {
    it('the bill list carries Paid / Outstanding / Payment Status and filters by status', async () => {
      const mobile = newMobile();
      const unpaid = await bill(A.token, mA, mobile, 300);
      const partial = await bill(A.token, mA, mobile, 300);
      const full = await bill(A.token, mA, mobile, 300);
      await receiptOk(A.token, mA, mobile, [{ billId: partial.id, amount: 100 }, { billId: full.id, amount: 300 }]);
      const rows = (await req(A.token, 'GET', `/api/bills?search=${mobile}&limit=50`)).json().data.rows as { id: string; paidAmount: number; outstandingAmount: number; paymentStatus: string }[];
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(unpaid.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 300, paymentStatus: 'UNPAID' });
      expect(byId.get(partial.id)).toMatchObject({ paidAmount: 100, outstandingAmount: 200, paymentStatus: 'PARTIALLY_PAID' });
      expect(byId.get(full.id)).toMatchObject({ paidAmount: 300, outstandingAmount: 0, paymentStatus: 'PAID' });

      const filters = encodeURIComponent(JSON.stringify([{ field: 'paymentStatus', op: 'equals', value: 'PARTIALLY_PAID' }]));
      const filtered = (await req(A.token, 'GET', `/api/bills?search=${mobile}&filters=${filters}`)).json().data;
      expect(filtered.rows.map((r: { id: string }) => r.id)).toEqual([partial.id]);
      expect(filtered.total).toBe(1);

      // Paid / Outstanding sort, and a raw filter on them is ignored rather than failing the query.
      const bad = encodeURIComponent(JSON.stringify([{ field: 'outstandingAmount', op: 'gt', value: 'abc' }]));
      expect((await req(A.token, 'GET', `/api/bills?search=${mobile}&filters=${bad}`)).statusCode).toBe(200);
      const sorted = (await req(A.token, 'GET', `/api/bills?search=${mobile}&sortBy=outstandingAmount&sortOrder=asc`)).json().data.rows;
      expect(sorted.map((r: { outstandingAmount: number }) => r.outstandingAmount)).toEqual([0, 200, 300]);
    });

    it('customers and pending bills: oldest first, fully paid bills left out, totals derived', async () => {
      const mobile = newMobile();
      const later = await bill(A.token, mA, mobile, 800, { billDate: '2026-09-22', customerName: 'Latest Name' });
      const older = await bill(A.token, mA, mobile, 500, { billDate: '2026-09-01' });
      const settled = await bill(A.token, mA, mobile, 200, { billDate: '2026-08-01' });
      await receiptOk(A.token, mA, mobile, [{ billId: settled.id, amount: 200 }, { billId: older.id, amount: 100 }]);

      const pending = (await req(A.token, 'GET', `/api/receipts/pending-bills?customer=${mobile}`)).json().data;
      expect(pending.map((p: { id: string }) => p.id)).toEqual([older.id, later.id]);
      expect(pending[0]).toMatchObject({ grandTotal: 500, paidAmount: 100, outstandingAmount: 400, paymentStatus: 'PARTIALLY_PAID' });

      const [c] = (await req(A.token, 'GET', `/api/receipts/customers?key=${mobile}`)).json().data;
      expect(c).toMatchObject({ customerKey: mobile, customerName: 'Latest Name', billCount: 3, pendingBillCount: 2, totalBilled: 1500, totalPaid: 300, totalOutstanding: 1200 });
      const found = (await req(A.token, 'GET', `/api/receipts/customers?search=Latest%20Name`)).json().data;
      expect(found.some((x: { customerKey: string }) => x.customerKey === mobile)).toBe(true);
    });

    it('the receipt list finds a receipt by the bill it settled', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 100);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 100 }]);
      const rows = (await req(A.token, 'GET', `/api/receipts?search=${encodeURIComponent(`${b.bookNumber}/${b.billNumber}`)}`)).json().data.rows;
      expect(rows.map((x: { id: string }) => x.id)).toContain(r.id);
      expect(rows.find((x: { id: string }) => x.id === r.id)).toMatchObject({ billNumbers: `${b.bookNumber}/${b.billNumber}`, accountName: 'CASH IN HAND', createdByName: 'rcpt-tenant-a Tester' });
    });

    it('a zero-total bill is PAID and never pending', async () => {
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 0);
      expect((await payments(A.token, b.id)).paymentStatus).toBe('PAID');
      expect((await req(A.token, 'GET', `/api/receipts/pending-bills?customer=${mobile}`)).json().data).toEqual([]);
    });
  });

  /* ---------------------------------------------------- public invoice link -- */

  describe('the public invoice link (Phase 5.1)', () => {
    it('survives a receipt and its cancellation — payment is not a bill edit', async () => {
      process.env.PUBLIC_APP_URL = 'https://studio.example.com';
      process.env.PUBLIC_LINK_SECRET = 'receipts-test-secret-0123456789-abcdef';
      const mobile = newMobile();
      const b = await bill(A.token, mA, mobile, 1000);
      const link = await req(A.token, 'POST', `/api/bills/${b.id}/invoice/public-link`, {});
      expect(link.statusCode, link.body).toBe(200);
      const r = await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 500 }]);
      await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {});
      const active = await db.select().from(schema.publicInvoiceLinks).where(and(eq(schema.publicInvoiceLinks.billId, b.id), isNull(schema.publicInvoiceLinks.revokedAt)));
      expect(active).toHaveLength(1);
      const state = (await req(A.token, 'GET', `/api/bills/${b.id}/invoice/public-link`)).json().data;
      expect(state).toMatchObject({ active: true, url: link.json().data.url });

      // A real bill edit still revokes it, receipts or not (the edit keeps Grand Total >= Paid).
      await receiptOk(A.token, mA, mobile, [{ billId: b.id, amount: 200 }]);
      const edited = await req(A.token, 'PUT', `/api/bills/${b.id}`, {
        billDate: '2026-09-20',
        customerName: 'Receipt Customer',
        mobileNumber: mobile,
        taxMode: 'WITHOUT_GST',
        items: [{ itemId: mA.item.id, subItemId: mA.subItem.id, quantity: 1, rate: 900 }],
      });
      expect(edited.statusCode, edited.body).toBe(200);
      const after = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, b.id));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ revokeReason: 'BILL_UPDATED' });
      expect(after[0].revokedAt).not.toBeNull();
    });
  });
});
