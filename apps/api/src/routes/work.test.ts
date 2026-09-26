import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { workPosition } from '@erp/shared';

/**
 * The studio workflow (docs/STUDIO_WORKFLOW.md): Selection -> Editing -> WhatsApp -> Delivery, the
 * Work Queue, Reports -> Delivery and the appointment Done / Reopen actions.
 *
 * Section A always runs: the derived position. Section B needs TEST_DATABASE_URL (a THROWAWAY
 * database). "Today" is always the server's business date, read from a response.
 */

/* ------------------------------------------------ A. pure behaviour -- */

describe('workPosition', () => {
  it('is the stage after the furthest one recorded — earlier stages never have to be faked; a recorded Delivery closes the job', () => {
    expect(workPosition({})).toBe('SELECTION');
    expect(workPosition({ SELECTION: 'DONE' })).toBe('EDITING');
    expect(workPosition({ SELECTION: 'DONE', EDITING: 'SKIPPED' })).toBe('WHATSAPP');
    expect(workPosition({ SELECTION: 'DONE', EDITING: 'DONE', WHATSAPP: 'SKIPPED' })).toBe('DELIVERY');
    expect(workPosition({ EDITING: 'DONE' })).toBe('WHATSAPP');
    expect(workPosition({ SELECTION: 'DONE', WHATSAPP: 'DONE' })).toBe('DELIVERY');
    expect(workPosition({ WHATSAPP: 'SKIPPED' })).toBe('DELIVERY');
    expect(workPosition({ DELIVERY: 'DONE' })).toBe('COMPLETE');
    expect(workPosition({ DELIVERY: 'SKIPPED' })).toBe('COMPLETE');
  });
});

/* ------------------------------------------- B. against a database -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

const addDays = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

describe.skipIf(!TEST_DB)('Studio workflow (integration, needs TEST_DATABASE_URL)', () => {
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
    operations_work: ['read', 'update'],
    operations_appointments: ['read', 'create', 'update', 'delete'],
    reports_receivables: ['read'],
  };

  const req = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const getOk = async <T = any>(token: string, url: string) => {
    const res = await req(token, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as T;
  };

  /* ---------------------------------------------------------- fixtures -- */

  async function seedUser(tenantId: string, name: string, grants: Record<string, string[]>) {
    const [role] = await db.insert(schema.roles).values({ tenantId, name: `${name} role ${Math.random().toString(36).slice(2, 6)}`, permissions: grants }).returning();
    const [user] = await db
      .insert(schema.users)
      .values({ tenantId, roleId: role.id, firstName: name, lastName: 'Tester', email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: 'not-a-real-hash' })
      .returning();
    return app.jwt.sign({ sub: user.id, tenantId });
  }
  /** A tenant with its own admin, book, 0% product and cash account — a fresh one gives exact counts. */
  async function seedTenant(name: string) {
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const [book] = await db.insert(schema.books).values({ tenantId, bookNumber: `WK${Math.random().toString(36).slice(2, 7)}`, seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId, itemName: `Item-${Math.random().toString(36).slice(2, 8)}`, hsnCode: '9983', gstRate: '0.00' }).returning();
    const [subItem] = await db.insert(schema.subItems).values({ tenantId, itemId: item.id, productName: `Prod-${Math.random().toString(36).slice(2, 8)}`, rate: '100.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    return { tenantId, token: await seedUser(tenantId, name, FULL), book, item, subItem, cash };
  }
  type Tenant = Awaited<ReturnType<typeof seedTenant>>;

  const newMobile = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

  type Bill = { id: string; billNumber: number; bookNumber: string; nextAppointmentId: string | null };
  async function bill(t: Tenant, total: number, overrides: Record<string, unknown> = {}) {
    const res = await req(t.token, 'POST', '/api/bills', {
      bookId: t.book.id,
      billDate: day0,
      customerName: 'Work Customer',
      mobileNumber: newMobile(),
      taxMode: 'WITHOUT_GST',
      items: [{ itemId: t.item.id, subItemId: t.subItem.id, quantity: 1, rate: total }],
      ...overrides,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Bill;
  }
  async function appointment(t: Tenant, appointmentDate: string, overrides: Record<string, unknown> = {}) {
    const res = await req(t.token, 'POST', '/api/appointments', { appointmentDate, customerName: 'Appointment Customer', mobileNumber: newMobile(), ...overrides });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as { id: string; appointmentNumber: number };
  }

  type Work = { billId: string; position: string; stages: { stage: string; outcome: string; completedOn: string; completedAt: string }[] };
  const stage = (token: string, billId: string, s: string, outcome?: 'DONE' | 'SKIPPED') =>
    req(token, 'POST', `/api/work/bills/${billId}/stages/${s}`, outcome ? { outcome } : {});
  const stageOk = async (token: string, billId: string, s: string, outcome?: 'DONE' | 'SKIPPED') => {
    const res = await stage(token, billId, s, outcome);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data as Work;
  };
  const reopen = (token: string, billId: string, s: string) => req(token, 'DELETE', `/api/work/bills/${billId}/stages/${s}`);
  const workOf = (token: string, billId: string) => getOk<Work>(token, `/api/work/bills/${billId}`);
  const shareOpened = (token: string, billId: string, body: Record<string, unknown>) => req(token, 'POST', `/api/bills/${billId}/invoice/share-opened`, body);
  const payments = (token: string, billId: string) => getOk<{ paidAmount: number; outstandingAmount: number; paymentStatus: string; availableAdvance: number }>(token, `/api/bills/${billId}/payments`);
  const delivery = (token: string, view: string) => getOk<{ today: string; rows: any[]; total: number; counts: Record<string, number> }>(token, `/api/reports/delivery?view=${view}&limit=100`);
  const queue = (token: string, q = '') => getOk<{ today: string; view: string; searchedAllPending: boolean; rows: any[]; total: number; counts: Record<string, number> }>(token, `/api/work/queue?limit=100${q}`);
  const appointments = (token: string, view: string) => getOk<{ today: string; rows: any[]; total: number; counts: Record<string, number> }>(token, `/api/appointments?view=${view}&limit=100`);
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  /* ------------------------------------------------------------- state -- */

  let A: Tenant;
  let B: Tenant;
  let today = '';
  let day0 = '';

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

    A = await seedTenant('work-tenant-a');
    B = await seedTenant('work-tenant-b');
    today = (await queue(A.token)).today;
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

  /* ------------------------------------------------------------ stages -- */

  describe('stages', () => {
    it('a new bill starts at Selection; one click completes a stage and a repeat click changes nothing', async () => {
      const b = await bill(A, 1000);
      expect(await workOf(A.token, b.id)).toMatchObject({ billId: b.id, position: 'SELECTION', stages: [] });

      const first = await stageOk(A.token, b.id, 'SELECTION');
      expect(first.position).toBe('EDITING');
      expect(first.stages).toEqual([expect.objectContaining({ stage: 'SELECTION', outcome: 'DONE', completedOn: today })]);

      const repeat = await stage(A.token, b.id, 'SELECTION');
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json().message).toMatch(/already recorded/);
      expect(repeat.json().data.stages).toEqual(first.stages);

      expect((await stageOk(A.token, b.id, 'EDITING')).position).toBe('WHATSAPP');
    });

    it('WhatsApp is never marked done by hand — only by opening WhatsApp from the workflow', async () => {
      const b = await bill(A, 1000);
      await stageOk(A.token, b.id, 'SELECTION');
      await stageOk(A.token, b.id, 'EDITING');

      const manual = await stage(A.token, b.id, 'WHATSAPP', 'DONE');
      expect(manual.statusCode).toBe(400);
      const manualDefault = await stage(A.token, b.id, 'WHATSAPP');
      expect(manualDefault.statusCode).toBe(400);
      expect((await workOf(A.token, b.id)).position).toBe('WHATSAPP');

      // A plain invoice share records no stage.
      expect((await shareOpened(A.token, b.id, {})).statusCode).toBe(200);
      expect((await workOf(A.token, b.id)).position).toBe('WHATSAPP');

      expect((await shareOpened(A.token, b.id, { workStage: 'WHATSAPP' })).statusCode).toBe(200);
      const w = await workOf(A.token, b.id);
      expect(w.position).toBe('DELIVERY');
      expect(w.stages.find((s) => s.stage === 'WHATSAPP')).toMatchObject({ outcome: 'DONE', completedOn: today });

      // Sharing again from the workflow is a no-op, not a second record.
      expect((await shareOpened(A.token, b.id, { workStage: 'WHATSAPP' })).statusCode).toBe(200);
      expect((await workOf(A.token, b.id)).stages.filter((s) => s.stage === 'WHATSAPP')).toEqual(w.stages.filter((s) => s.stage === 'WHATSAPP'));
      expect((await shareOpened(A.token, b.id, { workStage: 'DELIVERY' })).statusCode).toBe(400);
    });

    it('a skipped stage advances the job, and doing it later replaces SKIPPED with DONE', async () => {
      const b = await bill(A, 1000);
      expect((await stageOk(A.token, b.id, 'SELECTION', 'SKIPPED')).position).toBe('EDITING');
      await stageOk(A.token, b.id, 'EDITING');
      const skipped = await stageOk(A.token, b.id, 'WHATSAPP', 'SKIPPED');
      expect(skipped.position).toBe('DELIVERY');
      expect(skipped.stages.map((s) => [s.stage, s.outcome])).toEqual([
        ['SELECTION', 'SKIPPED'],
        ['EDITING', 'DONE'],
        ['WHATSAPP', 'SKIPPED'],
      ]);
      const done = await stageOk(A.token, b.id, 'SELECTION', 'DONE');
      expect(done.stages.find((s) => s.stage === 'SELECTION')).toMatchObject({ outcome: 'DONE' });
      expect(done.position).toBe('DELIVERY');
    });

    it('Mark Delivered completes the job and lists it as delivered today; reopening goes back; an unrecorded stage cannot be reopened', async () => {
      const b = await bill(A, 1000);
      await stageOk(A.token, b.id, 'SELECTION');
      await stageOk(A.token, b.id, 'EDITING');
      await shareOpened(A.token, b.id, { workStage: 'WHATSAPP' });
      expect((await stageOk(A.token, b.id, 'DELIVERY')).position).toBe('COMPLETE');

      const delivered = await delivery(A.token, 'DELIVERED');
      expect(delivered.rows.find((r) => r.id === b.id)).toMatchObject({ position: 'COMPLETE', deliveredOn: today, deliveryOutcome: 'DONE' });
      const list = await getOk<{ rows: { id: string; workPosition: string }[] }>(A.token, `/api/bills?search=${b.bookNumber}&limit=100`);
      expect(list.rows.find((r) => r.id === b.id)?.workPosition).toBe('COMPLETE');

      const reopened = await reopen(A.token, b.id, 'DELIVERY');
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(reopened.json().data.position).toBe('DELIVERY');
      expect(ids((await delivery(A.token, 'DELIVERED')).rows)).not.toContain(b.id);
      expect(ids((await delivery(A.token, 'PENDING')).rows)).toContain(b.id);

      const again = await reopen(A.token, b.id, 'DELIVERY');
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('WORK_STAGE_NOT_RECORDED');

      // Editing reopened while WhatsApp stays recorded: the job is still at Delivery (the step after the
      // furthest recorded one); Editing simply reads as not recorded. Reopening WhatsApp too goes back.
      const editingReopened = (await reopen(A.token, b.id, 'EDITING')).json().data;
      expect(editingReopened.position).toBe('DELIVERY');
      expect(editingReopened.stages.map((s: { stage: string }) => s.stage)).toEqual(['SELECTION', 'WHATSAPP']);
      expect((await reopen(A.token, b.id, 'WHATSAPP')).json().data.position).toBe('EDITING');
    });

    it('a step recorded out of order moves the job on without faking earlier steps — Today’s Work follows', async () => {
      const b = await bill(A, 1000, { billDate: today });
      const w = await stageOk(A.token, b.id, 'EDITING');
      expect(w.position).toBe('WHATSAPP');
      expect(w.stages.map((s) => s.stage)).toEqual(['EDITING']);
      expect((await queue(A.token, '&view=PENDING')).rows.find((r) => r.id === b.id)).toMatchObject({ next: 'WHATSAPP' });
      const list = await getOk<{ rows: { id: string; workPosition: string }[] }>(A.token, `/api/bills?search=${b.bookNumber}&limit=100`);
      expect(list.rows.find((r) => r.id === b.id)?.workPosition).toBe('WHATSAPP');
      // Correcting the mistake: Editing reopened -> back to Selection, on the bill and in the queue alike.
      expect((await reopen(A.token, b.id, 'EDITING')).json().data.position).toBe('SELECTION');
      expect((await queue(A.token, '&view=PENDING')).rows.find((r) => r.id === b.id)).toMatchObject({ next: 'SELECTION' });
    });

    it('Delivery recorded closes the job even when earlier stages were never recorded', async () => {
      const b = await bill(A, 1000);
      expect((await stageOk(A.token, b.id, 'DELIVERY')).position).toBe('COMPLETE');
    });

    it('refuses an unknown stage (400) and an unknown bill (404)', async () => {
      const b = await bill(A, 1000);
      expect((await stage(A.token, b.id, 'PRINTING')).statusCode).toBe(400);
      expect((await stage(A.token, b.id, 'SELECTION', 'MAYBE' as 'DONE')).statusCode).toBe(400);
      expect((await stage(A.token, '00000000-0000-4000-8000-00000000abcd', 'SELECTION')).statusCode).toBe(404);
      expect((await workOf(A.token, b.id)).stages).toEqual([]);
    });

    it('delivery never changes payment: delivered bills stay UNPAID / PARTIALLY_PAID', async () => {
      const mobile = newMobile();
      const part = await bill(A, 10000, { mobileNumber: mobile });
      const unpaid = await bill(A, 3000);
      const rc = await req(A.token, 'POST', '/api/receipts', { receiptDate: day0, customerMobile: mobile, paymentMode: 'CASH', accountId: A.cash.id, amount: 4000, allocations: [{ billId: part.id, amount: 4000 }] });
      expect(rc.statusCode, rc.body).toBe(200);

      await stageOk(A.token, part.id, 'DELIVERY');
      await stageOk(A.token, unpaid.id, 'DELIVERY');
      expect(await payments(A.token, part.id)).toMatchObject({ paidAmount: 4000, outstandingAmount: 6000, paymentStatus: 'PARTIALLY_PAID' });
      expect(await payments(A.token, unpaid.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 3000, paymentStatus: 'UNPAID' });
      const rows = (await delivery(A.token, 'DELIVERED')).rows;
      expect(rows.find((r) => r.id === part.id)).toMatchObject({ grandTotal: 10000, paymentStatus: 'PARTIALLY_PAID', outstandingAmount: 6000 });
      expect(rows.find((r) => r.id === unpaid.id)).toMatchObject({ grandTotal: 3000, paymentStatus: 'UNPAID', outstandingAmount: 3000 });
    });
  });

  /* --------------------------------------------------- delivery report -- */

  describe('Reports -> Delivery', () => {
    let D: Tenant;
    const evilName = '=HYPERLINK("http://evil.example","x")';
    const bills: Record<string, Bill> = {};

    beforeAll(async () => {
      D = await seedTenant('work-delivery');
      bills.noDate = await bill(D, 100, { customerName: evilName });
      bills.dueToday = await bill(D, 200, { deliveryDate: today });
      bills.overdue = await bill(D, 300, { deliveryDate: addDays(today, -1) });
      bills.future = await bill(D, 400, { deliveryDate: addDays(today, 3) });
      bills.delivered = await bill(D, 500, { deliveryDate: addDays(today, -2) });
      bills.skipped = await bill(D, 600, { deliveryDate: addDays(today, -2) });
      await stageOk(D.token, bills.delivered.id, 'DELIVERY');
      await stageOk(D.token, bills.skipped.id, 'DELIVERY', 'SKIPPED');
    });

    it('each view holds exactly its bills, and the counts agree', async () => {
      const expected: Record<string, string[]> = {
        PENDING: [bills.noDate.id, bills.dueToday.id, bills.overdue.id, bills.future.id],
        DUE_TODAY: [bills.dueToday.id],
        OVERDUE: [bills.overdue.id],
        DELIVERED: [bills.delivered.id],
        ALL: Object.values(bills).map((b) => b.id),
      };
      const counts = { PENDING: 4, DUE_TODAY: 1, OVERDUE: 1, DELIVERED: 1, ALL: 6 };
      for (const [view, want] of Object.entries(expected)) {
        const r = await delivery(D.token, view);
        expect(r.today).toBe(today);
        expect(ids(r.rows).sort(), view).toEqual([...want].sort());
        expect(r.total, view).toBe(want.length);
        expect(r.counts, view).toEqual(counts);
      }
    });

    it('a bill with no Delivery Date is pending but neither due today nor overdue', async () => {
      const pending = (await delivery(D.token, 'PENDING')).rows.find((r) => r.id === bills.noDate.id);
      expect(pending).toMatchObject({ plannedDelivery: null, position: 'SELECTION', deliveredOn: null });
    });

    it('a skipped delivery is not delivered and not pending', async () => {
      const row = (await delivery(D.token, 'ALL')).rows.find((r) => r.id === bills.skipped.id);
      expect(row).toMatchObject({ position: 'COMPLETE', deliveryOutcome: 'SKIPPED', deliveredOn: null });
    });

    it('CSV export: header, every row of the view, and spreadsheet formulas neutralised', async () => {
      const res = await req(D.token, 'GET', '/api/reports/delivery/export?view=ALL');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      const lines = res.body.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(lines[0]).toBe('Book,Bill No,Bill Date,Customer,Mobile,Baby,Planned Delivery,Current Stage,Delivered On,Grand Total,Payment Status,Outstanding');
      expect(lines).toHaveLength(7);
      expect(res.body).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
      expect(res.body).not.toMatch(/,=HYPERLINK/);
      expect(res.body).toContain('Delivery not needed');
    });
  });

  /* -------------------------------------------------------- work queue -- */

  describe("Today's Work (work queue views)", () => {
    let Q: Tenant;
    const sharedMobile = newMobile();
    const r: Record<string, { id: string }> = {};

    beforeAll(async () => {
      Q = await seedTenant('work-queue');
      r.aPast = await appointment(Q, addDays(today, -3));
      r.aToday = await appointment(Q, today, { mobileNumber: sharedMobile, customerName: 'Shared Mobile Appt' });
      r.aFuture = await appointment(Q, addDays(today, 3));
      r.aDone = await appointment(Q, today);
      expect((await req(Q.token, 'POST', `/api/appointments/${r.aDone.id}/done`)).statusCode).toBe(200);

      // Not started, not dated, billed 10 days ago: pending, but nothing to do TODAY.
      r.bSel = await bill(Q, 100, { mobileNumber: sharedMobile });
      r.bEdit = await bill(Q, 100, { customerName: 'Zubin Unique Editing' });
      await stageOk(Q.token, r.bEdit.id, 'SELECTION');
      r.bWa = await bill(Q, 100);
      await stageOk(Q.token, r.bWa.id, 'SELECTION');
      await stageOk(Q.token, r.bWa.id, 'EDITING');
      r.bDel = await bill(Q, 100, { deliveryDate: addDays(today, -1) });
      await stageOk(Q.token, r.bDel.id, 'SELECTION');
      await stageOk(Q.token, r.bDel.id, 'EDITING');
      await stageOk(Q.token, r.bDel.id, 'WHATSAPP', 'SKIPPED');
      r.bDueToday = await bill(Q, 100, { deliveryDate: today });
      r.bNew = await bill(Q, 100, { billDate: today });
      r.bFuture = await bill(Q, 100, { deliveryDate: addDays(today, 2) });
      r.bDone = await bill(Q, 100);
      await stageOk(Q.token, r.bDone.id, 'DELIVERY');
    });

    it('Today (the default): overdue, today’s appointments, today’s deliveries, work under way, new today — most urgent first', async () => {
      const t = await queue(Q.token);
      expect(t.view).toBe('TODAY');
      // 1 overdue (by date), 2 today's appointment, 3 delivery today, 4 under way / new (by date, then number).
      expect(ids(t.rows)).toEqual([r.aPast.id, r.bDel.id, r.aToday.id, r.bDueToday.id, r.bEdit.id, r.bWa.id, r.bNew.id]);
      expect(t.counts).toEqual({ TODAY: 7, PENDING: 10, UPCOMING: 2, COMPLETED: 2 });
      const byId = new Map(t.rows.map((x) => [x.id, x]));
      expect(byId.get(r.aPast.id)).toMatchObject({ kind: 'APPOINTMENT', next: 'APPOINTMENT', dueDate: addDays(today, -3), overdue: true });
      expect(byId.get(r.aToday.id)).toMatchObject({ kind: 'APPOINTMENT', dueDate: today, overdue: false });
      expect(byId.get(r.bDel.id)).toMatchObject({ kind: 'BILL', next: 'DELIVERY', dueDate: addDays(today, -1), overdue: true });
      expect(byId.get(r.bEdit.id)).toMatchObject({ next: 'EDITING', plannedDelivery: null, overdue: false, paymentStatus: 'UNPAID', outstandingAmount: 100 });
      expect(byId.get(r.bWa.id)).toMatchObject({ next: 'WHATSAPP' });
      expect(byId.get(r.bNew.id)).toMatchObject({ next: 'SELECTION', billDate: today });
    });

    it('Pending = everything unfinished; Upcoming = dated after today, soonest first; Completed = done, latest first', async () => {
      expect(ids((await queue(Q.token, '&view=PENDING')).rows).sort()).toEqual(
        [r.aPast.id, r.aToday.id, r.aFuture.id, r.bSel.id, r.bEdit.id, r.bWa.id, r.bDel.id, r.bDueToday.id, r.bNew.id, r.bFuture.id].sort(),
      );
      expect(ids((await queue(Q.token, '&view=UPCOMING')).rows)).toEqual([r.bFuture.id, r.aFuture.id]);
      const done = await queue(Q.token, '&view=COMPLETED');
      expect(ids(done.rows)).toEqual([r.bDone.id, r.aDone.id]);
      expect(done.rows.every((x) => x.next === 'COMPLETE' && typeof x.completedAt === 'string')).toBe(true);
      expect((await req(Q.token, 'GET', '/api/work/queue?view=NOPE')).statusCode).toBe(400);
    });

    it('a search on Today looks through everything unfinished; the view counts ignore the search', async () => {
      const byName = await queue(Q.token, '&search=zubin');
      expect(ids(byName.rows)).toEqual([r.bEdit.id]);
      expect(byName.counts.TODAY).toBe(7);
      const spaced = `${sharedMobile.slice(0, 5)} ${sharedMobile.slice(5)}`;
      const byMobile = await queue(Q.token, `&search=${encodeURIComponent(spaced)}`);
      // bSel is not on Today, but a search finds it — nobody has to guess the view.
      expect(ids(byMobile.rows).sort()).toEqual([r.aToday.id, r.bSel.id].sort());
      expect(byMobile).toMatchObject({ total: 2, searchedAllPending: true });
      expect((await queue(Q.token, '&view=COMPLETED&search=zubin')).rows).toEqual([]);
    });

    it("shows the customer's advance and what Apply would take — min(advance, due), derived", async () => {
      const adv = await req(Q.token, 'POST', '/api/receipts', { receiptDate: today, customerMobile: sharedMobile, paymentMode: 'CASH', accountId: Q.cash.id, amount: 3000, allocations: [] });
      expect(adv.statusCode, adv.body).toBe(200);
      const rows = (await queue(Q.token, '&view=PENDING')).rows;
      expect(rows.find((x) => x.id === r.aToday.id)).toMatchObject({ availableAdvance: 3000, advanceToApply: 0 });
      expect(rows.find((x) => x.id === r.bSel.id)).toMatchObject({ availableAdvance: 3000, advanceToApply: 100, outstandingAmount: 100 });
      expect(rows.find((x) => x.id === r.bEdit.id)).toMatchObject({ availableAdvance: 0, advanceToApply: 0 });
      // Showing it applies nothing: the bill still owes all of it.
      expect(await payments(Q.token, r.bSel.id)).toMatchObject({ paidAmount: 0, outstandingAmount: 100, availableAdvance: 3000 });
    });

    it('Done / Delivered moves the item from Today to Completed', async () => {
      const b = await bill(Q, 100, { billDate: today });
      const a = await appointment(Q, today);
      expect(ids((await queue(Q.token)).rows)).toEqual(expect.arrayContaining([b.id, a.id]));
      await stageOk(Q.token, b.id, 'DELIVERY');
      await req(Q.token, 'POST', `/api/appointments/${a.id}/done`);
      const after = await queue(Q.token);
      expect(ids(after.rows)).not.toContain(b.id);
      expect(ids(after.rows)).not.toContain(a.id);
      expect(after.counts).toMatchObject({ TODAY: 7, COMPLETED: 4 });
      expect(ids((await queue(Q.token, '&view=COMPLETED')).rows)).toEqual(expect.arrayContaining([b.id, a.id]));
    });

    it('someone without appointment access sees the jobs but no appointment rows', async () => {
      const workOnly = await seedUser(Q.tenantId, 'work-only', { operations_work: ['read'] });
      const q = await queue(workOnly);
      expect(q.counts).toMatchObject({ TODAY: 5 });
      expect(q.rows.every((x) => x.kind === 'BILL')).toBe(true);
      // Studio Work alone sees no money: no Due, no status, no advance.
      expect(q.rows.every((x) => x.outstandingAmount === null && x.paymentStatus === null && x.availableAdvance === 0 && x.advanceToApply === 0)).toBe(true);
      const withBilling = await seedUser(Q.tenantId, 'work-billing', { operations_work: ['read'], operations_billing: ['read'] });
      expect((await queue(withBilling)).rows.every((x) => x.outstandingAmount === 100)).toBe(true);

      // The Delivery report follows the same rule — on screen and in its CSV.
      const d = await delivery(workOnly, 'ALL');
      expect(d.rows.length).toBeGreaterThan(0);
      expect(d.rows.every((x) => x.grandTotal === null && x.paymentStatus === null && x.outstandingAmount === null)).toBe(true);
      const csv = await req(workOnly, 'GET', '/api/reports/delivery/export?view=ALL');
      expect(csv.statusCode).toBe(200);
      const header = csv.body.slice(1).split('\r\n')[0];
      expect(header).not.toMatch(/Grand Total|Payment Status|Outstanding/);
      expect(csv.body).not.toContain('100.00');
      const dMoney = await delivery(withBilling, 'ALL');
      expect(dMoney.rows.every((x) => x.grandTotal === 100 && x.outstandingAmount === 100 && x.paymentStatus === 'UNPAID')).toBe(true);
      expect((await req(withBilling, 'GET', '/api/reports/delivery/export?view=ALL')).body.slice(1).split('\r\n')[0]).toContain('Grand Total,Payment Status,Outstanding');
    });

    it('a skipped Delivery is completed but reported as SKIPPED — never as delivered', async () => {
      const b = await bill(Q, 100, { billDate: today });
      await stageOk(Q.token, b.id, 'DELIVERY', 'SKIPPED');
      const done = (await queue(Q.token, '&view=COMPLETED')).rows;
      expect(done.find((x) => x.id === b.id)).toMatchObject({ next: 'COMPLETE', deliveryOutcome: 'SKIPPED' });
      expect(done.find((x) => x.id === r.bDone.id)).toMatchObject({ deliveryOutcome: 'DONE' });
    });
  });

  /* ------------------------------------------------------ appointments -- */

  describe('appointments Done / Reopen', () => {
    let P: Tenant;
    beforeAll(async () => {
      P = await seedTenant('work-appointments');
    });

    it('Done leaves Pending and Today for Done and All; repeat is a no-op; Reopen brings it back', async () => {
      const a = await appointment(P, today);
      const later = await appointment(P, addDays(today, 5));
      expect(ids((await appointments(P.token, 'PENDING')).rows)).toEqual([a.id, later.id]);
      expect(ids((await appointments(P.token, 'TODAY')).rows)).toEqual([a.id]);
      expect(ids((await appointments(P.token, 'UPCOMING')).rows)).toEqual([later.id]);
      expect((await appointments(P.token, 'ALL')).counts).toEqual({ TODAY: 1, UPCOMING: 1, PENDING: 2, DONE: 0, ALL: 2 });

      const done = await req(P.token, 'POST', `/api/appointments/${a.id}/done`);
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().data).toMatchObject({ id: a.id, status: 'DONE' });
      const completedAt = done.json().data.completedAt;
      expect(completedAt).toBeTruthy();

      const repeat = await req(P.token, 'POST', `/api/appointments/${a.id}/done`);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json().data).toMatchObject({ status: 'DONE', completedAt });

      expect(ids((await appointments(P.token, 'PENDING')).rows)).toEqual([later.id]);
      expect(ids((await appointments(P.token, 'TODAY')).rows)).toEqual([]);
      expect(ids((await appointments(P.token, 'DONE')).rows)).toEqual([a.id]);
      const all = await appointments(P.token, 'ALL');
      expect(all.rows.find((x) => x.id === a.id)).toMatchObject({ status: 'DONE' });
      expect(all.counts).toEqual({ TODAY: 0, UPCOMING: 1, PENDING: 1, DONE: 1, ALL: 2 });
      expect(all.today).toBe(today);

      const reopened = await req(P.token, 'POST', `/api/appointments/${a.id}/reopen`);
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().data).toMatchObject({ status: 'PENDING', completedAt: null });
      expect(ids((await appointments(P.token, 'PENDING')).rows)).toEqual([a.id, later.id]);
      expect((await appointments(P.token, 'ALL')).counts).toEqual({ TODAY: 1, UPCOMING: 1, PENDING: 2, DONE: 0, ALL: 2 });
    });

    it("a bill's Next Visit Date creates a pending appointment", async () => {
      const visit = addDays(today, 7);
      const b = await bill(P, 100, { nextVisitDate: visit, customerName: 'Next Visit Customer' });
      expect(b.nextAppointmentId).toBeTruthy();
      const pending = await appointments(P.token, 'PENDING');
      expect(pending.rows.find((x) => x.id === b.nextAppointmentId)).toMatchObject({ appointmentDate: visit, status: 'PENDING', sourceBillId: b.id, customerName: 'Next Visit Customer' });
      expect(ids((await appointments(P.token, 'UPCOMING')).rows)).toContain(b.nextAppointmentId);
      // A future visit is not work for today.
      expect(ids((await queue(P.token)).rows)).not.toContain(b.nextAppointmentId);
    });

    it('unknown appointment is 404', async () => {
      expect((await req(P.token, 'POST', '/api/appointments/00000000-0000-4000-8000-00000000abcd/done')).statusCode).toBe(404);
    });
  });

  /* ------------------------------------------------------- end to end -- */

  describe('end to end', () => {
    it('appointment Done -> ₹5,000 advance -> ₹20,000 bill through every stage -> apply ₹5,000', async () => {
      const E = await seedTenant('work-e2e');
      const mobile = newMobile();
      const appt = await appointment(E, today, { mobileNumber: mobile, customerName: 'Meera Joshi' });
      expect((await req(E.token, 'POST', `/api/appointments/${appt.id}/done`)).statusCode).toBe(200);

      const adv = await req(E.token, 'POST', '/api/receipts', { receiptDate: today, customerMobile: mobile, customerName: 'Meera Joshi', paymentMode: 'CASH', accountId: E.cash.id, amount: 5000, allocations: [] });
      expect(adv.statusCode, adv.body).toBe(200);
      expect(adv.json().data).toMatchObject({ amount: 5000, availableAmount: 5000 });

      const b = await bill(E, 20000, { billDate: today, mobileNumber: mobile, customerName: 'Meera Joshi' });
      expect((await stageOk(E.token, b.id, 'SELECTION')).position).toBe('EDITING');
      expect((await stageOk(E.token, b.id, 'EDITING')).position).toBe('WHATSAPP');
      expect((await shareOpened(E.token, b.id, { workStage: 'WHATSAPP' })).statusCode).toBe(200);
      expect((await workOf(E.token, b.id)).position).toBe('DELIVERY');
      expect((await stageOk(E.token, b.id, 'DELIVERY')).position).toBe('COMPLETE');

      const applied = await req(E.token, 'POST', '/api/receipts/apply-advance', { billId: b.id, amount: 5000 });
      expect(applied.statusCode, applied.body).toBe(200);

      expect(await getOk(E.token, `/api/receipts/advance?customer=${mobile}`)).toMatchObject({ availableAdvance: 0, receipts: [] });
      expect(await payments(E.token, b.id)).toMatchObject({ paidAmount: 5000, outstandingAmount: 15000, paymentStatus: 'PARTIALLY_PAID', availableAdvance: 0 });
      expect(await workOf(E.token, b.id)).toMatchObject({ position: 'COMPLETE' });
      expect((await delivery(E.token, 'DELIVERED')).rows.find((r) => r.id === b.id)).toMatchObject({ deliveredOn: today, paymentStatus: 'PARTIALLY_PAID', outstandingAmount: 15000 });
      expect(ids((await appointments(E.token, 'PENDING')).rows)).not.toContain(appt.id);
      expect(ids((await appointments(E.token, 'DONE')).rows)).toContain(appt.id);
      expect((await appointments(E.token, 'ALL')).rows.find((r) => r.id === appt.id)).toMatchObject({ status: 'DONE' });
      expect((await queue(E.token)).counts).toMatchObject({ TODAY: 0, PENDING: 0 });
    });
  });

  /* ------------------------------------------------ permissions / tenancy -- */

  describe('permissions and tenant isolation', () => {
    it('Studio Work read may look but not record, skip, reopen or record WhatsApp via share', async () => {
      const b = await bill(A, 100);
      await stageOk(A.token, b.id, 'SELECTION');
      const readOnly = await seedUser(A.tenantId, 'work-read', { operations_work: ['read'], operations_billing: ['read'] });
      expect((await req(readOnly, 'GET', '/api/work/queue')).statusCode).toBe(200);
      expect((await req(readOnly, 'GET', `/api/work/bills/${b.id}`)).statusCode).toBe(200);
      expect((await stage(readOnly, b.id, 'EDITING')).statusCode).toBe(403);
      expect((await stage(readOnly, b.id, 'WHATSAPP', 'SKIPPED')).statusCode).toBe(403);
      expect((await reopen(readOnly, b.id, 'SELECTION')).statusCode).toBe(403);
      expect((await shareOpened(readOnly, b.id, { workStage: 'WHATSAPP' })).statusCode).toBe(403);
      // Billing read may still share the invoice without touching the workflow.
      expect((await shareOpened(readOnly, b.id, {})).statusCode).toBe(200);
      expect(await workOf(A.token, b.id)).toMatchObject({ position: 'EDITING', stages: [expect.objectContaining({ stage: 'SELECTION' })] });
    });

    it('without Studio Work read: no queue, no job progress, no Delivery report or export', async () => {
      const b = await bill(A, 100);
      const none = await seedUser(A.tenantId, 'work-none', { operations_billing: ['read'] });
      for (const url of ['/api/work/queue', `/api/work/bills/${b.id}`, '/api/reports/delivery', '/api/reports/delivery/export']) {
        expect((await req(none, 'GET', url)).statusCode, url).toBe(403);
      }
    });

    it('Appointments read-only cannot mark Done or reopen', async () => {
      const a = await appointment(A, today);
      const apptRead = await seedUser(A.tenantId, 'appt-read', { operations_appointments: ['read'] });
      expect((await req(apptRead, 'POST', `/api/appointments/${a.id}/done`)).statusCode).toBe(403);
      expect((await req(apptRead, 'POST', `/api/appointments/${a.id}/reopen`)).statusCode).toBe(403);
      expect((await getOk(A.token, `/api/appointments/${a.id}`)).status).toBe('PENDING');
    });

    it("tenant B can neither move nor see tenant A's jobs and appointments", async () => {
      const b = await bill(A, 100);
      const a = await appointment(A, today);
      expect((await stage(B.token, b.id, 'SELECTION')).statusCode).toBe(404);
      expect((await reopen(B.token, b.id, 'SELECTION')).statusCode).toBe(404);
      expect((await req(B.token, 'GET', `/api/work/bills/${b.id}`)).statusCode).toBe(404);
      expect((await shareOpened(B.token, b.id, { workStage: 'WHATSAPP' })).statusCode).toBe(404);
      expect((await req(B.token, 'POST', `/api/appointments/${a.id}/done`)).statusCode).toBe(404);
      expect((await workOf(A.token, b.id)).stages).toEqual([]);

      const q = await queue(B.token);
      expect(ids(q.rows)).not.toContain(b.id);
      expect(ids(q.rows)).not.toContain(a.id);
      expect(ids((await delivery(B.token, 'ALL')).rows)).not.toContain(b.id);
      expect(ids((await appointments(B.token, 'ALL')).rows)).not.toContain(a.id);
    });
  });
});
