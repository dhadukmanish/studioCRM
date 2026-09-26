import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AGING_BUCKETS, ageInDays, agingBucket, fromPaise, receivablesScopeSchema, toPaise, todayInTimeZone as todayIn } from '@erp/shared';
import { csvCell, csvNumber, toCsv } from '../lib/csv';

/**
 * Receivables / Outstanding reports (Phase 7, docs/RECEIVABLES_REPORTS.md).
 *
 * Section A always runs: aging buckets and their boundaries, whole-day ages that no time zone can
 * shift, the business "today", CSV formula-injection protection, and the scope validation.
 *
 * Section B needs TEST_DATABASE_URL (a THROWAWAY database): multi-bill receipts counted once per
 * bill, multiple and cancelled receipts, aging of the remaining outstanding, As of, customer
 * identity by normalized mobile, reconciliation of Summary = Outstanding Bills = Aging = KPI,
 * filters, pagination totals, sorting, CSV, RBAC and tenant isolation.
 */

/* ------------------------------------------------ A. pure behaviour -- */

describe('aging buckets', () => {
  it('0 / 1-30 / 31-60 / 61-90 / 91+ at every boundary', () => {
    const cases: [number, string][] = [[0, 'CURRENT'], [1, 'D1_30'], [30, 'D1_30'], [31, 'D31_60'], [60, 'D31_60'], [61, 'D61_90'], [90, 'D61_90'], [91, 'D90_PLUS'], [4000, 'D90_PLUS']];
    for (const [days, bucket] of cases) expect(agingBucket(days), `${days} days`).toBe(bucket);
  });

  it('ages are whole calendar days on the digits — leap years, month ends, never negative', () => {
    expect(ageInDays('2026-09-26', '2026-09-26')).toBe(0);
    expect(ageInDays('2026-03-01', '2026-02-28')).toBe(1);
    expect(ageInDays('2028-03-01', '2028-02-28')).toBe(2);
    expect(ageInDays('2027-01-01', '2026-12-31')).toBe(1);
    expect(ageInDays('2026-09-01', '2026-09-26')).toBe(0);
  });
});

describe('business today', () => {
  it('follows the company time zone, not the server clock', () => {
    const lateEveningUtc = new Date('2026-09-25T20:00:00Z'); // 01:30 on the 26th in India
    expect(todayIn('Asia/Kolkata', lateEveningUtc)).toBe('2026-09-26');
    expect(todayIn('UTC', lateEveningUtc)).toBe('2026-09-25');
    expect(todayIn('America/New_York', lateEveningUtc)).toBe('2026-09-25');
  });
  it('an unknown zone falls back to the studio default instead of failing', () => {
    expect(todayIn('Not/AZone', new Date('2026-09-25T20:00:00Z'))).toBe('2026-09-26');
  });
});

describe('CSV', () => {
  it('neutralises spreadsheet formulas in user text', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","click")')).toBe(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(csvCell('+SUM(A1:A9)')).toBe("'+SUM(A1:A9)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@something')).toBe("'@something");
    expect(csvCell('\t=1+1')).toBe("'\t=1+1");
    expect(csvCell('  =1+1')).toBe("'  =1+1");
  });
  it('leaves ordinary text and server numbers alone', () => {
    expect(csvCell('Rajesh Patel')).toBe('Rajesh Patel');
    expect(csvCell('રાજેશ પટેલ')).toBe('રાજેશ પટેલ');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(csvNumber(-12.5))).toBe('-12.50');
    expect(csvCell(csvNumber(1234567.891))).toBe('1234567.89');
    expect(csvCell(null)).toBe('');
  });
  it('is UTF-8 with a BOM and CRLF rows', () => {
    expect(toCsv(['A', 'B'], [['x', csvNumber(1)]])).toBe('﻿A,B\r\nx,1.00\r\n');
  });
});

describe('receivablesScopeSchema', () => {
  it('accepts real ISO dates and refuses a reversed range or a display-format date', () => {
    expect(receivablesScopeSchema.safeParse({ asOf: '2026-09-26', from: '2026-04-01', to: '2026-09-30' }).success).toBe(true);
    expect(receivablesScopeSchema.safeParse({ from: '2026-10-01', to: '2026-09-30' }).success).toBe(false);
    expect(receivablesScopeSchema.safeParse({ asOf: '26-09-2026' }).success).toBe(false);
    expect(receivablesScopeSchema.safeParse({ asOf: '2026-02-30' }).success).toBe(false);
    expect(receivablesScopeSchema.safeParse({ bookId: 'not-a-uuid' }).success).toBe(false);
  });
});

/* ------------------------------------------- B. against a database -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Receivables reports (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  const FULL = {
    operations_billing: ['read', 'create', 'update', 'delete'],
    operations_receipts: ['read', 'create', 'update'],
    reports_receivables: ['read'],
  };
  const AS_OF = '2026-09-26';
  const R = '/api/reports/receivables';

  const req = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const qs = (p: Record<string, unknown>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
    return s.toString() ? `?${s}` : '';
  };
  const get = async <T = any>(token: string, path: string, p: Record<string, unknown> = {}) => {
    const res = await req(token, 'GET', `${R}${path}${qs({ asOf: AS_OF, ...p })}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as T;
  };
  const paise = (n: number) => toPaise(n);
  const agingPaise = (a: Record<string, number>) => AGING_BUCKETS.reduce((s, b) => s + paise(a[b]), 0);

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
    return { tenantId, item, subItem, cash };
  }
  type Masters = Awaited<ReturnType<typeof seedMasters>>;

  /** A fresh book per test: filtering by it gives every test its own report scope inside one tenant. */
  async function newBook(tenantId: string, bookNumber = `RV${Math.random().toString(36).slice(2, 8)}`) {
    const [book] = await db.insert(schema.books).values({ tenantId, bookNumber, seriesStartsAt: 1, nextBillNumber: 1 }).returning();
    return book.id;
  }
  const newMobile = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

  async function bill(token: string, m: Masters, bookId: string, mobile: string, total: number, billDate = '2026-09-01', customerName = 'Report Customer') {
    const res = await req(token, 'POST', '/api/bills', {
      bookId,
      billDate,
      customerName,
      mobileNumber: mobile,
      taxMode: 'WITHOUT_GST',
      items: [{ itemId: m.item.id, subItemId: m.subItem.id, quantity: 1, rate: total }],
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; billNumber: number; grandTotal: number };
  }
  async function receipt(token: string, m: Masters, mobile: string, allocations: { billId: string; amount: number }[], receiptDate = '2026-09-20') {
    const res = await req(token, 'POST', '/api/receipts', {
      receiptDate,
      customerMobile: mobile,
      paymentMode: 'CASH',
      accountId: m.cash.id,
      amount: fromPaise(allocations.reduce((s, a) => s + toPaise(a.amount), 0)),
      allocations,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; receiptNumber: number };
  }
  /** Bill rows of a scope, keyed by bill id. */
  const billsOf = async (token: string, p: Record<string, unknown>) => {
    const d = await get<{ rows: any[]; total: number; totals: any }>(token, '/bills', { limit: 500, ...p });
    return { ...d, byId: new Map(d.rows.map((r) => [r.id, r])) };
  };

  /* ------------------------------------------------------------- state -- */

  let A = { tenantId: '', token: '', reportOnly: '', noReports: '' };
  let mA: Masters;
  let B = { tenantId: '', token: '' };
  let mB: Masters;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Never seed through a client that was built before DATABASE_URL was pointed at the throwaway
    // database (a top-level import of any db-touching module does exactly that).
    if (client.DATABASE_URL !== TEST_DB) throw new Error('The db client is not connected to TEST_DATABASE_URL — refusing to write test data');
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('rcv-tenant-a');
    A = {
      ...a,
      reportOnly: await seedUser(a.tenantId, 'rcv-report-only', { reports_receivables: ['read'], operations_receipts: ['read'], operations_billing: ['read'] }),
      noReports: await seedUser(a.tenantId, 'rcv-no-reports', { operations_billing: ['read'], operations_receipts: ['read', 'create', 'update'] }),
    };
    mA = await seedMasters(A.tenantId);
    B = await seedTenant('rcv-tenant-b');
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

  /* ------------------------------------------------------ money semantics -- */

  describe('Paid is allocations, never receipt totals', () => {
    it('one ₹12,000 receipt over A ₹10,000 + B ₹2,000 counts ₹12,000 once — C stays ₹8,000', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const a = await bill(A.token, mA, bookId, mobile, 10000);
      const b = await bill(A.token, mA, bookId, mobile, 5000);
      const c = await bill(A.token, mA, bookId, mobile, 8000);
      await receipt(A.token, mA, mobile, [{ billId: a.id, amount: 10000 }, { billId: b.id, amount: 2000 }]);

      const all = await billsOf(A.token, { bookId, status: 'ALL' });
      expect(all.byId.get(a.id)).toMatchObject({ grandTotal: 10000, paidAmount: 10000, outstandingAmount: 0, paymentStatus: 'PAID' });
      expect(all.byId.get(b.id)).toMatchObject({ grandTotal: 5000, paidAmount: 2000, outstandingAmount: 3000, paymentStatus: 'PARTIALLY_PAID' });
      expect(all.byId.get(c.id)).toMatchObject({ grandTotal: 8000, paidAmount: 0, outstandingAmount: 8000, paymentStatus: 'UNPAID' });
      expect(all.totals).toMatchObject({ totalBilled: 23000, totalPaid: 12000, totalOutstanding: 11000, pendingBills: 2, count: 3 });

      // Default Outstanding view: A (paid) is not listed.
      const outstanding = await billsOf(A.token, { bookId });
      expect(outstanding.rows.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
      expect(outstanding.totals.totalOutstanding).toBe(11000);

      const summary = await get(A.token, '/customers', { bookId });
      expect(summary.rows).toHaveLength(1);
      expect(summary.rows[0]).toMatchObject({ customerKey: mobile, totalBilled: 23000, totalPaid: 12000, totalOutstanding: 11000, pendingBills: 2, billCount: 3 });

      const detail = await get(A.token, `/customers/${mobile}`, { bookId });
      expect(detail.customer).toMatchObject({ totalBilled: 23000, totalPaid: 12000, totalOutstanding: 11000, pendingBills: 2 });
      expect(detail.bills).toHaveLength(3);
      expect(detail.receipts).toHaveLength(1);
      expect(detail.receipts[0]).toMatchObject({ receiptAmount: 12000, allocatedAmount: 12000, status: 'ACTIVE' });
      expect(detail.receipts[0].allocations.map((x: any) => x.amount).sort((p: number, q: number) => p - q)).toEqual([2000, 10000]);

      const overview = await get(A.token, '/overview', { bookId });
      expect(overview).toMatchObject({ totalBilled: 23000, totalReceived: 12000, totalOutstanding: 11000, pendingBills: 2, customersWithOutstanding: 1 });
    });

    it('two receipts on one ₹10,000 bill: ₹3,000 + ₹2,000 = Paid ₹5,000, Outstanding ₹5,000', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const x = await bill(A.token, mA, bookId, mobile, 10000);
      await receipt(A.token, mA, mobile, [{ billId: x.id, amount: 3000 }]);
      await receipt(A.token, mA, mobile, [{ billId: x.id, amount: 2000 }]);
      const r = (await billsOf(A.token, { bookId })).byId.get(x.id);
      expect(r).toMatchObject({ paidAmount: 5000, outstandingAmount: 5000, paymentStatus: 'PARTIALLY_PAID' });
      const detail = await get(A.token, `/customers/${mobile}`, { bookId });
      expect(detail.receipts.map((z: any) => z.allocatedAmount)).toEqual([3000, 2000]);
    });

    it('a cancelled receipt adds ₹0 — Outstanding returns to ₹10,000 and the receipt stays in history as Cancelled', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const x = await bill(A.token, mA, bookId, mobile, 10000);
      const r = await receipt(A.token, mA, mobile, [{ billId: x.id, amount: 4000 }]);
      expect((await billsOf(A.token, { bookId })).byId.get(x.id)).toMatchObject({ paidAmount: 4000, outstandingAmount: 6000 });

      expect((await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, { reason: 'Cheque bounced' })).statusCode).toBe(200);
      expect((await billsOf(A.token, { bookId })).byId.get(x.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 10000, paymentStatus: 'UNPAID' });
      const detail = await get(A.token, `/customers/${mobile}`, { bookId });
      expect(detail.customer).toMatchObject({ totalPaid: 0, totalOutstanding: 10000 });
      expect(detail.receipts).toEqual([expect.objectContaining({ receiptNumber: r.receiptNumber, status: 'CANCELLED', allocatedAmount: 4000 })]);
      expect((await get(A.token, '/overview', { bookId })).totalReceived).toBe(0);
    });

    it('a zero-total bill is PAID and never a receivable', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const z = await bill(A.token, mA, bookId, mobile, 0);
      expect((await billsOf(A.token, { bookId, status: 'ALL' })).byId.get(z.id)).toMatchObject({ grandTotal: 0, outstandingAmount: 0, paymentStatus: 'PAID' });
      expect((await billsOf(A.token, { bookId })).rows).toHaveLength(0);
      expect((await get(A.token, '/customers', { bookId })).rows).toHaveLength(0);
      expect((await get(A.token, '/overview', { bookId })).pendingBills).toBe(0);
    });

    it('a customer with a paid, a part-paid and an unpaid bill owes ₹11,000 on 2 pending bills', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const a = await bill(A.token, mA, bookId, mobile, 10000);
      const b = await bill(A.token, mA, bookId, mobile, 5000);
      await bill(A.token, mA, bookId, mobile, 8000);
      await receipt(A.token, mA, mobile, [{ billId: a.id, amount: 10000 }]);
      await receipt(A.token, mA, mobile, [{ billId: b.id, amount: 2000 }]);
      expect((await get(A.token, '/customers', { bookId })).rows[0]).toMatchObject({ totalOutstanding: 11000, pendingBills: 2, billCount: 3 });
    });
  });

  /* ---------------------------------------------------------------- aging -- */

  describe('aging', () => {
    it('buckets each bill by whole days from its bill date at every boundary', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const dayBefore = (n: number) => new Date(Date.UTC(2026, 8, 26 - n)).toISOString().slice(0, 10);
      const expected: Record<number, string> = { 0: 'CURRENT', 1: 'D1_30', 30: 'D1_30', 31: 'D31_60', 60: 'D31_60', 61: 'D61_90', 90: 'D61_90', 91: 'D90_PLUS' };
      const ids = new Map<string, number>();
      for (const n of Object.keys(expected).map(Number)) ids.set((await bill(A.token, mA, bookId, mobile, 100 + n, dayBefore(n))).id, n);
      const { rows, totals } = await billsOf(A.token, { bookId });
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        const n = ids.get(r.id)!;
        expect(r.ageDays, `bill ${n} days old`).toBe(n);
        expect(r.agingBucket, `bill ${n} days old`).toBe(expected[n]);
        expect(r.agingBucket).toBe(agingBucket(ageInDays(AS_OF, r.billDate)));
      }
      expect(totals.aging).toEqual({ CURRENT: 100, D1_30: 101 + 130, D31_60: 131 + 160, D61_90: 161 + 190, D90_PLUS: 191 });
      expect(agingPaise(totals.aging)).toBe(paise(totals.totalOutstanding));

      // Bucket drill-down uses the same query: exactly the bills of that bucket.
      const b31 = await billsOf(A.token, { bookId, bucket: 'D31_60' });
      expect(b31.rows.map((r) => r.ageDays).sort((x, y) => x - y)).toEqual([31, 60]);
      expect(b31.totals.totalOutstanding).toBe(totals.aging.D31_60);
    });

    it('a partly paid bill ages only what is still outstanding', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const x = await bill(A.token, mA, bookId, mobile, 10000, '2026-08-12'); // 45 days before 2026-09-26
      await receipt(A.token, mA, mobile, [{ billId: x.id, amount: 7000 }], '2026-08-20');
      const { totals } = await billsOf(A.token, { bookId });
      expect(totals.aging).toEqual({ CURRENT: 0, D1_30: 0, D31_60: 3000, D61_90: 0, D90_PLUS: 0 });
      expect((await get(A.token, '/customers', { bookId })).rows[0].aging.D31_60).toBe(3000);
    });
  });

  /* ---------------------------------------------------------------- as of -- */

  describe('As of', () => {
    it('counts only bills and receipts dated on or before it', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const x = await bill(A.token, mA, bookId, mobile, 10000, '2026-09-01');
      await receipt(A.token, mA, mobile, [{ billId: x.id, amount: 4000 }], '2026-09-20');
      const future = await bill(A.token, mA, bookId, mobile, 500, '2026-10-01');

      const before = await billsOf(A.token, { bookId, asOf: '2026-09-15', status: 'ALL' });
      expect(before.byId.get(x.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 10000, ageDays: 14 });
      expect(before.byId.has(future.id)).toBe(false);

      const after = await billsOf(A.token, { bookId, asOf: '2026-09-25', status: 'ALL' });
      expect(after.byId.get(x.id)).toMatchObject({ paidAmount: 4000, outstandingAmount: 6000 });
      expect(after.byId.has(future.id)).toBe(false);

      const later = await billsOf(A.token, { bookId, asOf: '2026-10-05', status: 'ALL' });
      expect(later.byId.get(future.id)).toMatchObject({ ageDays: 4, agingBucket: 'D1_30' });
      // A receipt dated after As of is not in the customer's history for that date either.
      expect((await get(A.token, `/customers/${mobile}`, { bookId, asOf: '2026-09-15' })).receipts).toHaveLength(0);
    });

    it('defaults to today in the company time zone and says which date it used', async () => {
      const res = await req(A.token, 'GET', `${R}/overview`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.asOf).toBe(todayIn('Asia/Kolkata'));
    });
  });

  /* ------------------------------------------------------ customer identity -- */

  describe('customer = normalized mobile', () => {
    it('one mobile typed two ways, with two name spellings, is ONE customer; one name on two mobiles is TWO', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      await bill(A.token, mA, bookId, mobile, 1000, '2026-09-01', 'Rajesh Patel');
      await bill(A.token, mA, bookId, `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}`, 2000, '2026-09-02', 'Rajesh Patal');
      const other = newMobile();
      await bill(A.token, mA, bookId, other, 4000, '2026-09-03', 'Rajesh Patel');

      const { rows } = await get(A.token, '/customers', { bookId });
      expect(rows).toHaveLength(2);
      const one = rows.find((r: any) => r.customerKey === mobile);
      expect(one).toMatchObject({ totalOutstanding: 3000, billCount: 2, customerName: 'Rajesh Patal' }); // latest bill's spelling
      expect(rows.find((r: any) => r.customerKey === other)).toMatchObject({ totalOutstanding: 4000, billCount: 1 });

      // A search on one spelling still totals ALL of that customer's bills — never a partial balance.
      const searched = await get(A.token, '/customers', { bookId, search: 'Patal' });
      expect(searched.rows).toEqual([expect.objectContaining({ customerKey: mobile, totalOutstanding: 3000, billCount: 2 })]);
    });

    it('the same mobile in another tenant is another customer, never combined', async () => {
      const bookA = await newBook(A.tenantId);
      const bookB = await newBook(B.tenantId);
      const mobile = newMobile();
      await bill(A.token, mA, bookA, mobile, 1000);
      await bill(B.token, mB, bookB, mobile, 7000);
      expect((await get(A.token, `/customers/${mobile}`)).customer.totalBilled).toBe(1000);
      expect((await get(B.token, `/customers/${mobile}`)).customer.totalBilled).toBe(7000);
    });
  });

  /* -------------------------------------------------------- reconciliation -- */

  describe('reconciliation', () => {
    it('KPI = Summary = Outstanding Bills = Aging, to the paisa, in the same scope', async () => {
      const bookId = await newBook(A.tenantId);
      const customers = Array.from({ length: 6 }, newMobile);
      let n = 0;
      for (const mobile of customers) {
        const bills = [];
        for (let i = 0; i < 4; i++) bills.push(await bill(A.token, mA, bookId, mobile, Number((1000 + 333.33 * (n++ % 7)).toFixed(2)), `2026-0${5 + (i % 4)}-1${i}`));
        await receipt(A.token, mA, mobile, [{ billId: bills[0].id, amount: bills[0].grandTotal }, { billId: bills[1].id, amount: 0.01 }], '2026-09-01');
        const r = await receipt(A.token, mA, mobile, [{ billId: bills[2].id, amount: 99.99 }], '2026-09-02');
        if (n % 8 === 0) await req(A.token, 'POST', `/api/receipts/${r.id}/cancel`, {});
      }
      const overview = await get(A.token, '/overview', { bookId });
      const summary = await get(A.token, '/customers', { bookId, limit: 2 });
      const bills = await get(A.token, '/bills', { bookId, limit: 5 });
      const all = await get(A.token, '/bills', { bookId, status: 'ALL', limit: 5 });

      const o = paise(overview.totalOutstanding);
      expect(o).toBeGreaterThan(0);
      expect(paise(summary.totals.totalOutstanding)).toBe(o);
      expect(paise(bills.totals.totalOutstanding)).toBe(o);
      expect(agingPaise(overview.aging)).toBe(o);
      expect(agingPaise(summary.totals.aging)).toBe(o);
      expect(agingPaise(bills.totals.aging)).toBe(o);
      expect(paise(all.totals.totalBilled) - paise(all.totals.totalPaid)).toBe(o);
      expect(paise(overview.totalBilled)).toBe(paise(all.totals.totalBilled));
      expect(paise(overview.totalReceived)).toBe(paise(all.totals.totalPaid));
      expect(summary.totals.pendingBills).toBe(overview.pendingBills);
      expect(bills.total).toBe(overview.pendingBills);
      expect(summary.total).toBe(overview.customersWithOutstanding);
      // Each customer row agrees with its own bills.
      for (const c of (await get(A.token, '/customers', { bookId, limit: 50 })).rows) {
        const own = await get(A.token, '/bills', { bookId, customer: c.customerKey, status: 'ALL', limit: 50 });
        expect(paise(own.totals.totalOutstanding)).toBe(paise(c.totalOutstanding));
        expect(agingPaise(c.aging)).toBe(paise(c.totalOutstanding));
      }
    });
  });

  /* ---------------------------------------------------- filters and paging -- */

  describe('filters, pagination and sorting', () => {
    it('Book and bill-date range narrow every view to the same scope', async () => {
      const book1 = await newBook(A.tenantId);
      const book2 = await newBook(A.tenantId);
      const mobile = newMobile();
      await bill(A.token, mA, book1, mobile, 1000, '2026-06-10');
      await bill(A.token, mA, book1, mobile, 2000, '2026-08-10');
      await bill(A.token, mA, book2, mobile, 4000, '2026-08-11');

      const scope = { bookId: book1, from: '2026-08-01', to: '2026-08-31' };
      expect((await get(A.token, '/overview', scope)).totalOutstanding).toBe(2000);
      expect((await get(A.token, '/customers', scope)).rows[0]).toMatchObject({ customerKey: mobile, totalOutstanding: 2000, billCount: 1 });
      expect((await get(A.token, '/bills', scope)).totals.totalOutstanding).toBe(2000);
      expect((await get(A.token, `/customers/${mobile}`, scope)).bills).toHaveLength(1);
      const csv = (await req(A.token, 'GET', `${R}/export${qs({ report: 'bills', asOf: AS_OF, ...scope })}`)).body;
      expect(csv.trim().split('\r\n')).toHaveLength(2);
    });

    it('status filter picks Unpaid / Partially paid / Paid', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const u = await bill(A.token, mA, bookId, mobile, 100);
      const p = await bill(A.token, mA, bookId, mobile, 200);
      const f = await bill(A.token, mA, bookId, mobile, 300);
      await receipt(A.token, mA, mobile, [{ billId: p.id, amount: 50 }, { billId: f.id, amount: 300 }]);
      const ids = async (status: string) => (await billsOf(A.token, { bookId, status })).rows.map((r) => r.id).sort();
      expect(await ids('UNPAID')).toEqual([u.id]);
      expect(await ids('PARTIALLY_PAID')).toEqual([p.id]);
      expect(await ids('PAID')).toEqual([f.id]);
      expect(await ids('OUTSTANDING')).toEqual([u.id, p.id].sort());
      expect((await ids('ALL')).length).toBe(3);
    });

    it('a page holds page-size rows while the totals cover every matching row; pages never overlap', async () => {
      const bookId = await newBook(A.tenantId);
      for (let i = 0; i < 23; i++) await bill(A.token, mA, bookId, newMobile(), 100 + i, `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`);
      const expectedTotal = Array.from({ length: 23 }, (_, i) => 100 + i).reduce((s, x) => s + x, 0);

      const seen = new Set<string>();
      for (const page of [1, 2, 3]) {
        const d = await get(A.token, '/customers', { bookId, limit: 10, page, sortBy: 'totalOutstanding', sortOrder: 'asc' });
        expect(d.rows).toHaveLength(page === 3 ? 3 : 10);
        expect(d.total).toBe(23);
        expect(d.totals.totalOutstanding).toBe(expectedTotal);
        expect(d.totals.pendingBills).toBe(23);
        for (const r of d.rows) seen.add(r.customerKey);
      }
      expect(seen.size).toBe(23);

      const b = await get(A.token, '/bills', { bookId, limit: 10, page: 2, sortBy: 'outstandingAmount', sortOrder: 'desc' });
      expect(b.rows).toHaveLength(10);
      expect(b.totals).toMatchObject({ count: 23, totalOutstanding: expectedTotal, totalBilled: expectedTotal });
      expect(b.rows.map((r: any) => r.outstandingAmount)).toEqual(Array.from({ length: 10 }, (_, i) => 112 - i));

      const asc = (await get(A.token, '/customers', { bookId, limit: 5, sortBy: 'totalOutstanding', sortOrder: 'asc' })).rows.map((r: any) => r.totalOutstanding);
      expect(asc).toEqual([100, 101, 102, 103, 104]);
      const byAge = (await get(A.token, '/customers', { bookId, limit: 3, sortBy: 'oldestPendingAge', sortOrder: 'desc' })).rows;
      expect(byAge[0].oldestPendingDate).toBe('2026-08-01');
    });

    it('rejects bad input instead of guessing', async () => {
      for (const q of ['?asOf=26-09-2026', '?from=2026-10-01&to=2026-09-01', '?bookId=nope', '?status=SOMETIMES', '?bucket=D1_365']) {
        expect((await req(A.token, 'GET', `${R}/bills${q}`)).statusCode, q).toBe(400);
      }
      expect((await req(A.token, 'GET', `${R}/export?report=everything`)).statusCode).toBe(400);
    });
  });

  /* --------------------------------------------------------------------- CSV -- */

  describe('CSV export', () => {
    it('exports the whole filtered result, not the page, with injection-safe text', async () => {
      const bookId = await newBook(A.tenantId);
      const names = ['=HYPERLINK("http://evil.example","x")', '+SUM(A1:A2)', '@cmd', 'રાજેશ પટેલ', 'राजेश'];
      for (let i = 0; i < 25; i++) await bill(A.token, mA, bookId, newMobile(), 1000 + i, '2026-09-01', names[i % names.length]);

      const res = await req(A.token, 'GET', `${R}/export${qs({ report: 'bills', asOf: AS_OF, bookId, limit: 5, page: 2 })}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="Outstanding-Bills-as-of-${AS_OF}.csv"`);
      const body = res.body;
      expect(body.startsWith('﻿')).toBe(true);
      const lines = body.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe('Book,Bill No,Bill Date,Customer,Mobile,Grand Total,Paid,Outstanding,Payment Status,Age (days from bill date),Aging Bucket');
      expect(lines).toHaveLength(26); // every row, not page 2 of 5
      expect(body).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
      expect(body).toContain("'+SUM(A1:A2)");
      expect(body).toContain("'@cmd");
      expect(body).toContain('રાજેશ પટેલ');
      expect(body).toContain('राजेश');
      expect(body).not.toMatch(/,=HYPERLINK|,\+SUM|,@cmd/);
      expect(lines[1]).toMatch(/,2026-09-01,.*,1000\.00,0\.00,1000\.00,Unpaid,25,1–30 days$/);

      const summary = (await req(A.token, 'GET', `${R}/export${qs({ report: 'customers', asOf: AS_OF, bookId })}`)).body.slice(1).trim().split('\r\n');
      expect(summary).toHaveLength(26);
      const aging = (await req(A.token, 'GET', `${R}/export${qs({ report: 'aging', asOf: AS_OF, bookId })}`)).body.slice(1).trim().split('\r\n');
      expect(aging[0]).toBe('Customer,Mobile,Current,1–30 days,31–60 days,61–90 days,90+ days,Total Outstanding,Oldest Pending Bill Date');
      expect(aging).toHaveLength(26);
    });
  });

  /* ----------------------------------------------------- RBAC and tenancy -- */

  describe('RBAC', () => {
    it('no report permission: every report endpoint is 403', async () => {
      for (const path of ['/overview', '/customers', '/bills', '/customers/9876543210', '/export?report=bills']) {
        expect((await req(A.noReports, 'GET', `${R}${path}`)).statusCode, path).toBe(403);
      }
    });

    it('report View cannot create a receipt — Receive payment still needs Receipts Create', async () => {
      const bookId = await newBook(A.tenantId);
      const mobile = newMobile();
      const x = await bill(A.token, mA, bookId, mobile, 500);
      expect((await req(A.reportOnly, 'GET', `${R}/bills${qs({ bookId, asOf: AS_OF })}`)).statusCode).toBe(200);
      const res = await req(A.reportOnly, 'POST', '/api/receipts', { receiptDate: AS_OF, customerMobile: mobile, paymentMode: 'CASH', accountId: mA.cash.id, amount: 500, allocations: [{ billId: x.id, amount: 500 }] });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it('aggregates never include another tenant\'s bills, customers or allocations', async () => {
      const bookB = await newBook(B.tenantId);
      const mobile = newMobile();
      const x = await bill(B.token, mB, bookB, mobile, 9999);
      await receipt(B.token, mB, mobile, [{ billId: x.id, amount: 1111 }]);

      // Tenant A, even naming B's book and B's customer, sees nothing of B.
      expect((await get(A.token, '/overview', { bookId: bookB })).totalBilled).toBe(0);
      expect((await get(A.token, '/customers', { bookId: bookB })).total).toBe(0);
      expect((await get(A.token, '/bills', { bookId: bookB, status: 'ALL' })).total).toBe(0);
      expect((await req(A.token, 'GET', `${R}/customers/${mobile}?asOf=${AS_OF}`)).statusCode).toBe(404);
      const aAll = await get(A.token, '/bills', { status: 'ALL', search: mobile });
      expect(aAll.total).toBe(0);

      // B sees exactly its own figures.
      expect(await get(B.token, '/overview', { bookId: bookB })).toMatchObject({ totalBilled: 9999, totalReceived: 1111, totalOutstanding: 8888 });
    });
  });
});
