import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { billReportQuerySchema, toPaise, todayInTimeZone } from '@erp/shared';
import { containsPattern } from '../lib/filters';

/**
 * Reports -> Bill Summary (docs/BILL_SUMMARY_REPORT.md).
 *
 * Section A always runs: the scope schema and the literal-search pattern.
 *
 * Section B needs TEST_DATABASE_URL (a THROWAWAY database): saved bill figures, Advance = derived
 * Paid (one receipt across two bills, several receipts, an applied advance, a cancelled receipt;
 * the customer's UNAPPLIED advance never counted), Summary = Detailed to the paisa with no line
 * multiplied by receipts, every filter, search, sorting, pagination with whole-set totals, CSV,
 * RBAC and tenant isolation.
 */

/* ------------------------------------------------ A. pure behaviour -- */

describe('billReportQuerySchema', () => {
  it('treats blank query values as "not set"', () => {
    const v = billReportQuerySchema.parse({ from: '2026-08-01', to: '2026-08-31', customer: '', bookId: '', seriesType: '', billNumber: '', paymentStatus: '', search: '' });
    expect(v).toMatchObject({ from: '2026-08-01', to: '2026-08-31', customer: undefined, bookId: undefined, seriesType: undefined, billNumber: undefined, paymentStatus: undefined, search: undefined, full: false });
  });
  it('refuses a reversed range, a display-format date, a bad bill no., book, series or payment status', () => {
    expect(billReportQuerySchema.safeParse({ from: '2026-09-01', to: '2026-08-31' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ from: '01-08-2026' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ billNumber: 'abc' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ billNumber: '0' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ bookId: 'nope' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ seriesType: 'GST' }).success).toBe(false);
    expect(billReportQuerySchema.safeParse({ paymentStatus: 'OUTSTANDING' }).success).toBe(false);
    expect(billReportQuerySchema.parse({ billNumber: '12' }).billNumber).toBe(12);
  });
});

describe('literal search pattern', () => {
  it('escapes LIKE wildcards and the escape character itself', () => {
    expect(containsPattern('50%')).toBe(String.raw`%50\%%`);
    expect(containsPattern('a_b')).toBe(String.raw`%a\_b%`);
    expect(containsPattern(String.raw`c:\x`)).toBe(String.raw`%c:\\x%`);
    expect(containsPattern('Riya')).toBe('%Riya%');
  });
});

/* ------------------------------------------- B. against a database -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Bill Summary Report (integration, needs TEST_DATABASE_URL)', () => {
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
    reports_bills: ['read'],
  };
  const R = '/api/reports/bills';
  const AUG = { from: '2026-08-01', to: '2026-08-31' };

  const req = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const qs = (p: Record<string, unknown>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
    return s.toString() ? `?${s}` : '';
  };
  const get = async <T = any>(token: string, path: string, p: Record<string, unknown> = {}) => {
    const res = await req(token, 'GET', `${R}${path}${qs(p)}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as T;
  };
  const summary = (token: string, p: Record<string, unknown> = {}) => get<{ from: string; to: string; rows: any[]; total: number; totals: any }>(token, '/summary', { limit: 100, ...p });
  const detailed = (token: string, p: Record<string, unknown> = {}) => get<{ from: string; to: string; rows: any[]; total: number; totals: any }>(token, '/detailed', { limit: 100, ...p });
  const sumPaise = (xs: number[]) => xs.reduce((s, x) => s + toPaise(x), 0);

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
    const [g18] = await db.insert(schema.items).values({ tenantId, itemName: 'Album', hsnCode: '4911', gstRate: '18.00' }).returning();
    const [g0] = await db.insert(schema.items).values({ tenantId, itemName: 'Photo Session', hsnCode: '9983', gstRate: '0.00' }).returning();
    const [album] = await db.insert(schema.subItems).values({ tenantId, itemId: g18.id, productName: 'Premium Album', rate: '100.00' }).returning();
    const [frame] = await db.insert(schema.subItems).values({ tenantId, itemId: g18.id, productName: 'Walnut_Frame 50%', rate: '100.00' }).returning();
    const [shoot] = await db.insert(schema.subItems).values({ tenantId, itemId: g0.id, productName: 'Newborn Shoot', rate: '100.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    const [withGst] = await db.insert(schema.books).values({ tenantId, bookNumber: 'G-2026', seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITH_GST' }).returning();
    const [noGst] = await db.insert(schema.books).values({ tenantId, bookNumber: 'N-2026', seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    return { g18, g0, album, frame, shoot, cash, withGst: withGst.id, noGst: noGst.id };
  }
  type Masters = Awaited<ReturnType<typeof seedMasters>>;
  type Line = { itemId: string; subItemId: string; quantity: number; rate: number };

  async function bill(token: string, b: { bookId: string; billDate: string; customerName: string; mobile: string; lines: Line[]; discountType?: string; discountValue?: number; babyName?: string; deliveryDate?: string }) {
    const res = await req(token, 'POST', '/api/bills', {
      bookId: b.bookId,
      billDate: b.billDate,
      customerName: b.customerName,
      mobileNumber: b.mobile,
      babyName: b.babyName,
      deliveryDate: b.deliveryDate,
      discountType: b.discountType ?? 'NONE',
      discountValue: b.discountValue ?? 0,
      items: b.lines,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; billNumber: number; subTotal: number; discountAmount: number; gstAmount: number; grandTotal: number };
  }
  async function receipt(token: string, m: Masters, mobile: string, amount: number, allocations: { billId: string; amount: number }[]) {
    const res = await req(token, 'POST', '/api/receipts', { receiptDate: '2026-08-28', customerMobile: mobile, paymentMode: 'CASH', accountId: m.cash.id, amount, allocations });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string };
  }

  /* ------------------------------------------------------------- state -- */

  let A = { tenantId: '', token: '', reportOnly: '', noReport: '' };
  let m: Masters;
  let B = { tenantId: '', token: '' };
  // Riya: bills A and B; Karan: bills C and F. D and E sit outside August.
  const RIYA = '9812345670';
  const KARAN = '9898989898';
  let bA: Awaited<ReturnType<typeof bill>>;
  let bB: Awaited<ReturnType<typeof bill>>;
  let bC: Awaited<ReturnType<typeof bill>>;
  let bF: Awaited<ReturnType<typeof bill>>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('billrep-a');
    A = {
      ...a,
      reportOnly: await seedUser(a.tenantId, 'billrep-report-only', { reports_bills: ['read'] }),
      noReport: await seedUser(a.tenantId, 'billrep-no-report', { operations_billing: ['read', 'create', 'update', 'delete'], operations_receipts: ['read', 'create', 'update'], reports_receivables: ['read'] }),
    };
    m = await seedMasters(A.tenantId);
    const t = A.token;

    // A: Sub Total 10,000 (two lines, GST 18% + 0%), Discount ₹1,000.
    bA = await bill(t, { bookId: m.withGst, billDate: '2026-08-05', customerName: 'Riya Shah', mobile: RIYA, babyName: 'Baby Riya', deliveryDate: '2026-09-10', discountType: 'AMOUNT', discountValue: 1000, lines: [
      { itemId: m.g18.id, subItemId: m.album.id, quantity: 1, rate: 6000 },
      { itemId: m.g0.id, subItemId: m.shoot.id, quantity: 2, rate: 2000 },
    ] });
    // B: Sub Total 20,000 (three lines), Discount 10% = ₹2,000; same customer, another spelling of the name.
    bB = await bill(t, { bookId: m.withGst, billDate: '2026-08-20', customerName: 'Riya S.', mobile: RIYA, discountType: 'PERCENT', discountValue: 10, lines: [
      { itemId: m.g18.id, subItemId: m.album.id, quantity: 1, rate: 12000 },
      { itemId: m.g18.id, subItemId: m.frame.id, quantity: 3, rate: 1000.5 },
      { itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 4998.5 },
    ] });
    bC = await bill(t, { bookId: m.noGst, billDate: '2026-08-25', customerName: 'Karan Mehta', mobile: KARAN, lines: [{ itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 5000 }] });
    bF = await bill(t, { bookId: m.noGst, billDate: '2026-08-28', customerName: 'Karan Mehta', mobile: KARAN, lines: [{ itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 700 }] });
    await bill(t, { bookId: m.noGst, billDate: '2026-07-31', customerName: 'Karan Mehta', mobile: KARAN, lines: [{ itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 3000 }] });
    await bill(t, { bookId: m.noGst, billDate: '2026-09-01', customerName: 'Riya Shah', mobile: RIYA, lines: [{ itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 900 }] });

    // One receipt across A and B, with ₹2,000 more than it allocates — an advance left UNAPPLIED
    // except for the ₹500 applied to B below.
    await receipt(t, m, RIYA, 6500, [{ billId: bA.id, amount: 3000 }, { billId: bB.id, amount: 1500 }]);
    await receipt(t, m, RIYA, 1000, [{ billId: bB.id, amount: 1000 }]);
    const applied = await req(t, 'POST', '/api/receipts/apply-advance', { billId: bB.id, amount: 500 });
    expect(applied.statusCode, applied.body).toBe(200);
    // Karan: a receipt that was cancelled counts nowhere; a second one stands.
    const cancelled = await receipt(t, m, KARAN, 5000, [{ billId: bC.id, amount: 5000 }]);
    const c = await req(t, 'POST', `/api/receipts/${cancelled.id}/cancel`, { reason: 'Wrong bill' });
    expect(c.statusCode, c.body).toBe(200);
    await receipt(t, m, KARAN, 1200, [{ billId: bC.id, amount: 1200 }]);

    B = await seedTenant('billrep-b');
    const mB = await seedMasters(B.tenantId);
    await bill(B.token, { bookId: mB.noGst, billDate: '2026-08-10', customerName: 'Riya Shah', mobile: RIYA, lines: [{ itemId: mB.g0.id, subItemId: mB.shoot.id, quantity: 1, rate: 99999 }] });
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

  /* ------------------------------------------------------------- tests -- */

  it('with no dates the scope is the current month in the company time zone, and says so', async () => {
    const d = await summary(A.token);
    const today = todayInTimeZone('Asia/Kolkata');
    expect(d.to).toBe(today);
    expect(d.from).toBe(`${today.slice(0, 8)}01`);
  });

  it('Summary: one row per bill in the date range, the SAVED bill figures, chronological', async () => {
    const d = await summary(A.token, AUG);
    expect(d.rows.map((r) => r.id)).toEqual([bA.id, bB.id, bC.id, bF.id]);
    expect(d.total).toBe(4);
    for (const saved of [bA, bB, bC, bF]) {
      const r = d.rows.find((x) => x.id === saved.id);
      expect({ subTotal: r.subTotal, discount: r.discount, gst: r.gst, grandTotal: r.grandTotal }).toEqual({ subTotal: saved.subTotal, discount: saved.discountAmount, gst: saved.gstAmount, grandTotal: saved.grandTotal });
    }
    const a = d.rows[0];
    expect(a).toMatchObject({ bookNumber: 'G-2026', billNumber: bA.billNumber, customerName: 'Riya Shah', mobileNumber: RIYA, babyName: 'Baby Riya', billDate: '2026-08-05', plannedDelivery: '2026-09-10', seriesType: 'WITH_GST', subTotal: 10000, discount: 1000 });
    expect(d.rows[1]).toMatchObject({ subTotal: 20000, discount: 2000 });
  });

  it('Advance = received against the bill: one receipt split across two bills, several receipts, an applied advance; never the unapplied advance or a cancelled receipt', async () => {
    const d = await summary(A.token, AUG);
    const adv = Object.fromEntries(d.rows.map((r) => [r.id, r.advance]));
    expect(adv[bA.id]).toBe(3000); // its share of the split receipt only
    expect(adv[bB.id]).toBe(3000); // 1,500 (split receipt) + 1,000 (second receipt) + 500 applied advance
    expect(adv[bC.id]).toBe(1200); // the cancelled ₹5,000 counts nowhere
    expect(adv[bF.id]).toBe(0);
    // The customer's remaining ₹1,500 advance (2,000 unallocated − 500 applied) is in no bill.
    expect(d.totals.advance).toBe(7200);
    expect(d.rows.find((r) => r.id === bF.id).paymentStatus).toBe('UNPAID');
  });

  it('Summary totals are the whole filtered set, to the paisa', async () => {
    const d = await summary(A.token, AUG);
    expect(d.totals.bills).toBe(4);
    for (const k of ['subTotal', 'discount', 'gst', 'grandTotal', 'advance'] as const) {
      expect(toPaise(d.totals[k]), k).toBe(sumPaise(d.rows.map((r) => r[k])));
    }
    expect(d.totals.subTotal).toBe(10000 + 20000 + 5000 + 700);
    expect(d.totals.discount).toBe(3000);
  });

  it('Detailed: every line exactly once — receipts never multiply a bill’s lines — and it reconciles with Summary to the paisa', async () => {
    const s = await summary(A.token, AUG);
    const d = await detailed(A.token, AUG);
    expect(d.total).toBe(2 + 3 + 1 + 1);
    const keys = d.rows.map((r) => `${r.billId}:${r.lineNumber}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(d.rows.filter((r) => r.billId === bB.id).map((r) => r.lineNumber)).toEqual([1, 2, 3]); // 2 receipts + 1 application, still 3 lines
    // A bill's lines sit together, in line order, and exactly one of them carries its Advance.
    expect(d.rows.map((r) => r.billId)).toEqual([bA.id, bA.id, bB.id, bB.id, bB.id, bC.id, bF.id]);
    for (const id of [bA.id, bB.id, bC.id, bF.id]) {
      const lines = d.rows.filter((r) => r.billId === id);
      expect(lines.filter((r) => r.firstLine)).toHaveLength(1);
      expect(lines.filter((r) => r.advance !== null)).toHaveLength(1);
    }
    // Line figures: Amount = Qty × Rate, Discount = the stored allocation, Taxable = Amount − Discount.
    for (const r of d.rows) {
      expect(toPaise(r.amount)).toBe(toPaise(r.taxable) + toPaise(r.discount));
      expect(toPaise(r.lineTotal)).toBe(toPaise(r.taxable) + toPaise(r.gst));
    }
    // Reconciliation — the lines' sums ARE the bills' stored totals, and the Advance column adds up.
    expect(d.totals.bills).toBe(s.totals.bills);
    expect(d.totals.subTotal).toBe(s.totals.subTotal);
    expect(d.totals.discount).toBe(s.totals.discount);
    expect(d.totals.gst).toBe(s.totals.gst);
    expect(d.totals.grandTotal).toBe(s.totals.grandTotal);
    expect(d.totals.advance).toBe(s.totals.advance);
    expect(sumPaise(d.rows.map((r) => r.amount))).toBe(toPaise(s.totals.subTotal));
    expect(sumPaise(d.rows.map((r) => r.discount))).toBe(toPaise(s.totals.discount));
    expect(sumPaise(d.rows.map((r) => r.gst))).toBe(toPaise(s.totals.gst));
    expect(sumPaise(d.rows.map((r) => r.lineTotal))).toBe(toPaise(s.totals.grandTotal));
    expect(sumPaise(d.rows.filter((r) => r.advance !== null).map((r) => r.advance))).toBe(toPaise(s.totals.advance));
    expect(toPaise(d.totals.taxable)).toBe(toPaise(s.totals.subTotal) - toPaise(s.totals.discount));
    // Per bill too: B's lines add up to B's saved totals.
    const bLines = d.rows.filter((r) => r.billId === bB.id);
    expect(sumPaise(bLines.map((r) => r.discount))).toBe(toPaise(bB.discountAmount));
    expect(sumPaise(bLines.map((r) => r.lineTotal))).toBe(toPaise(bB.grandTotal));
  });

  it('every filter narrows BOTH tabs to the same bills, and they still reconcile', async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ customer: '+91-98123-45670' }, [bA.id, bB.id]], // any spelling of the mobile is the same customer
      [{ bookId: m.noGst }, [bC.id, bF.id]],
      [{ seriesType: 'WITH_GST' }, [bA.id, bB.id]],
      [{ seriesType: 'WITHOUT_GST' }, [bC.id, bF.id]],
      [{ bookId: m.withGst, billNumber: bB.billNumber }, [bB.id]],
      [{ paymentStatus: 'UNPAID' }, [bF.id]],
      [{ paymentStatus: 'PARTIALLY_PAID' }, [bA.id, bB.id, bC.id]],
      [{ search: 'Riya' }, [bA.id, bB.id]],
      [{ search: 'Walnut' }, [bB.id]], // a product name selects the BILL
      [{ search: '98123' }, [bA.id, bB.id]],
      [{ from: '2026-08-06', to: '2026-08-25' }, [bB.id, bC.id]],
    ];
    for (const [f, ids] of cases) {
      const p = { ...AUG, ...f };
      const s = await summary(A.token, p);
      const d = await detailed(A.token, p);
      expect(s.rows.map((r) => r.id), JSON.stringify(f)).toEqual(ids);
      expect([...new Set(d.rows.map((r) => r.billId))], JSON.stringify(f)).toEqual(ids);
      expect(d.totals.grandTotal, JSON.stringify(f)).toBe(s.totals.grandTotal);
      expect(d.totals.advance, JSON.stringify(f)).toBe(s.totals.advance);
    }
    // A product match keeps ALL of the bill's lines, so the bill still reconciles.
    expect((await detailed(A.token, { ...AUG, search: 'Walnut' })).rows).toHaveLength(3);
  });

  it('search treats % and _ literally', async () => {
    // Only bill B's product ('Walnut_Frame 50%') really contains them; as wildcards they would match all four.
    expect((await summary(A.token, { ...AUG, search: '%' })).rows.map((r) => r.id)).toEqual([bB.id]);
    expect((await summary(A.token, { ...AUG, search: '_' })).rows.map((r) => r.id)).toEqual([bB.id]);
    expect((await summary(A.token, { ...AUG, search: 'Riya%' })).total).toBe(0);
    expect((await summary(A.token, { ...AUG, search: 'Frame 50%' })).rows.map((r) => r.id)).toEqual([bB.id]);
    expect((await summary(A.token, { ...AUG, search: 'Walnut_' })).rows.map((r) => r.id)).toEqual([bB.id]);
  });

  it('sorts on the server, and a page never changes the totals', async () => {
    const byTotal = await summary(A.token, { ...AUG, sortBy: 'grandTotal', sortOrder: 'desc' });
    expect(byTotal.rows.map((r) => r.id)).toEqual([bB.id, bA.id, bC.id, bF.id]);
    const byAdvance = await summary(A.token, { ...AUG, sortBy: 'advance', sortOrder: 'asc' });
    expect(byAdvance.rows[0].id).toBe(bF.id);
    const byName = await summary(A.token, { ...AUG, sortBy: 'customerName', sortOrder: 'asc' });
    expect(byName.rows.map((r) => r.customerName)).toEqual(['Karan Mehta', 'Karan Mehta', 'Riya S.', 'Riya Shah']);
    // An unknown sort key — even an inherited property name — falls back to the default order instead of failing.
    for (const sortBy of ['nonsense', 'constructor', 'toString', '__proto__']) {
      expect((await summary(A.token, { ...AUG, sortBy })).rows.map((r) => r.id), sortBy).toEqual([bA.id, bB.id, bC.id, bF.id]);
    }

    const all = await summary(A.token, AUG);
    const p2 = await summary(A.token, { ...AUG, limit: 3, page: 2 });
    expect(p2.rows.map((r) => r.id)).toEqual([bF.id]);
    expect(p2.total).toBe(4);
    expect(p2.totals).toEqual(all.totals);
    const dAll = await detailed(A.token, AUG);
    const d2 = await detailed(A.token, { ...AUG, limit: 4, page: 2 });
    expect(d2.rows.map((r) => r.key)).toEqual(dAll.rows.slice(4).map((r) => r.key));
    expect(d2.totals).toEqual(dAll.totals);
    // Detailed sorts by BILL, keeping each bill's lines together and in order.
    const dSorted = await detailed(A.token, { ...AUG, sortBy: 'grandTotal', sortOrder: 'desc' });
    expect(dSorted.rows.map((r) => `${r.billId === bB.id ? 'B' : r.billId === bA.id ? 'A' : r.billId === bC.id ? 'C' : 'F'}${r.lineNumber}`)).toEqual(['B1', 'B2', 'B3', 'A1', 'A2', 'C1', 'F1']);
    // full=1 is every row regardless of the page size.
    expect((await summary(A.token, { ...AUG, limit: 1, full: 1 })).rows).toHaveLength(4);
  });

  it('CSV: whole filtered set, BOM, ISO dates, plain numbers, formula-guarded text; Detailed is one row per line and its Advance column adds up', async () => {
    await bill(A.token, { bookId: m.noGst, billDate: '2026-06-15', customerName: '=HYPERLINK("http://evil","x")', mobile: '9000000123', lines: [{ itemId: m.g0.id, subItemId: m.shoot.id, quantity: 1, rate: 100 }] });
    const res = await req(A.token, 'GET', `${R}/export${qs({ tab: 'summary', ...AUG, limit: 1 })}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('Bill-Summary-2026-08-01-to-2026-08-31.csv');
    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Book,Bill No,Bill Date,Customer,Mobile,Baby Name,Planned Delivery,Series,Sub Total,Discount,GST,Grand Total,Advance / Received,Payment Status');
    expect(lines).toHaveLength(1 + 4); // not just the one-row page
    expect(lines[1]).toContain(`G-2026,${bA.billNumber},2026-08-05,Riya Shah,${RIYA},Baby Riya,2026-09-10,With GST,10000.00,1000.00,`);

    const det = await req(A.token, 'GET', `${R}/export${qs({ tab: 'detailed', ...AUG })}`);
    const rows = det.body.slice(1).trimEnd().split('\r\n');
    expect(rows).toHaveLength(1 + 7);
    const adv = rows.slice(1).map((l) => l.split(',').at(-1)!).filter((v) => v !== '');
    expect(adv).toHaveLength(4);
    expect(adv.reduce((s, v) => s + toPaise(Number(v)), 0)).toBe(toPaise(7200));

    const evil = await req(A.token, 'GET', `${R}/export${qs({ tab: 'summary', from: '2026-06-15', to: '2026-06-15' })}`);
    expect(evil.body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });

  it('customers: by name or mobile, one per normalized mobile, and an exact key lookup', async () => {
    const found = await get<any[]>(A.token, '/customers', { search: 'riya' });
    expect(found.map((c) => c.customerKey)).toEqual([RIYA]);
    expect(found[0]).toMatchObject({ customerName: 'Riya Shah', billCount: 3 }); // named as the LATEST bill names them
    const byMobile = await get<any[]>(A.token, '/customers', { search: '9898' });
    expect(byMobile.map((c) => c.customerKey)).toEqual([KARAN]);
    expect(await get<any[]>(A.token, '/customers', { key: '+91 98989 89898' })).toHaveLength(1);
    expect(await get<any[]>(A.token, '/customers', { search: '%' })).toHaveLength(0);
  });

  it('RBAC: Bill Summary Report view is enough (no Billing edit), and nothing is served without it', async () => {
    expect((await summary(A.reportOnly, AUG)).total).toBe(4);
    expect((await detailed(A.reportOnly, AUG)).total).toBe(7);
    for (const path of ['/summary', '/detailed', '/customers', '/export?tab=summary']) {
      const res = await req(A.noReport, 'GET', `${R}${path}`);
      expect(res.statusCode, path).toBe(403);
    }
  });

  it('tenant isolation: another tenant’s bills, customers and books never appear', async () => {
    const other = await summary(B.token, AUG);
    expect(other.total).toBe(1);
    expect(other.totals.grandTotal).toBe(99999);
    expect((await summary(A.token, AUG)).rows.some((r) => r.grandTotal === 99999)).toBe(false);
    expect((await get<any[]>(B.token, '/customers', { search: 'riya' }))[0].billCount).toBe(1);
    // Tenant A's book id in tenant B's scope finds nothing.
    expect((await summary(B.token, { ...AUG, bookId: m.noGst })).total).toBe(0);
  });

  it('print / CSV past the row ceiling is refused with a message, never silently cut', async () => {
    const { assertExportable } = await import('../services/receivables');
    const { RECEIVABLES_EXPORT_MAX_ROWS } = await import('@erp/shared');
    expect(() => assertExportable(RECEIVABLES_EXPORT_MAX_ROWS)).not.toThrow();
    expect(() => assertExportable(RECEIVABLES_EXPORT_MAX_ROWS + 1)).toThrow(/at most 20000/);
  });

  it('refuses a malformed scope with a 400', async () => {
    const bad = await req(A.token, 'GET', `${R}/summary${qs({ from: '2026-09-01', to: '2026-08-01' })}`);
    expect(bad.statusCode).toBe(400);
    expect((await req(A.token, 'GET', `${R}/detailed?billNumber=abc`)).statusCode).toBe(400);
    expect((await req(A.token, 'GET', `${R}/export?tab=everything`)).statusCode).toBe(400);
  });
});
