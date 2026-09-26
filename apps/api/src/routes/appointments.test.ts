import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { appointmentSchema, normalizeMobile } from '@erp/shared';

/**
 * Appointment — the studio's booking record, and the customer information Billing will later
 * find by mobile number.
 *
 * Section A is pure validation — no database, always runs. Section B needs a database and is
 * skipped unless TEST_DATABASE_URL is set; it is where tenant isolation, permission
 * enforcement, the number allocator's sequence and concurrency, and the mobile lookup's
 * candidate ordering live.
 *
 * Bills do not exist in this phase, so nothing here bills an appointment.
 */

/* --------------------------------------------------------------- helpers -- */

/** Minimal valid Appointment payload; override only what the test is about. */
const makeAppointment = (overrides: Record<string, unknown> = {}) => ({
  appointmentDate: '2026-09-23',
  customerName: 'Ramesh Patel',
  mobileNumber: '9876543210',
  ...overrides,
});

const parseAppointment = (input: unknown, schema: ZodTypeAny = appointmentSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = appointmentSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('appointmentSchema (create payload)', () => {
  it('accepts a minimal appointment and leaves the optional fields empty', () => {
    expect(parseAppointment(makeAppointment())).toEqual({
      appointmentDate: '2026-09-23',
      appointmentTime: null,
      customerName: 'Ramesh Patel',
      mobileNumber: '9876543210',
      babyName: null,
      remark: null,
    });
  });

  it('accepts a full appointment', () => {
    expect(parseAppointment(makeAppointment({ appointmentTime: '10:30', babyName: 'Aarav', remark: 'Outdoor shoot' }))).toMatchObject({
      appointmentTime: '10:30',
      babyName: 'Aarav',
      remark: 'Outdoor shoot',
    });
  });

  /**
   * The number is system-issued. zod strips unknown keys, so a payload that tries to set it
   * loses the field entirely before any route code runs — on create and on update alike.
   */
  it('silently drops a client-supplied appointmentNumber', () => {
    expect(parseAppointment(makeAppointment({ appointmentNumber: 9999 }))).not.toHaveProperty('appointmentNumber');
  });

  it('silently drops a client-supplied mobileSearch, which is server-derived', () => {
    expect(parseAppointment(makeAppointment({ mobileSearch: '0000000000' }))).not.toHaveProperty('mobileSearch');
  });

  it('drops appointmentNumber from a partial (update) payload too', () => {
    expect(appointmentSchema.partial().parse({ appointmentNumber: 5, customerName: 'Meena' })).toEqual({ customerName: 'Meena' });
  });

  describe('appointmentDate', () => {
    it('is required', () => {
      const body = makeAppointment();
      delete (body as Record<string, unknown>).appointmentDate;
      expect(issuesFor(body)).toContainEqual({ path: 'appointmentDate', message: 'Appointment date is required' });
    });

    it('rejects a blank date', () => {
      expect(issuesFor(makeAppointment({ appointmentDate: '' }))).toContainEqual({ path: 'appointmentDate', message: 'Appointment date is required' });
    });

    it.each(['23-09-2026', '2026/09/23', '2026-9-3', 'today'])('rejects %p, which is not an ISO calendar date', (d) => {
      expect(issuesFor(makeAppointment({ appointmentDate: d }))).toContainEqual({ path: 'appointmentDate', message: 'Enter a valid appointment date' });
    });

    /** A date that does not exist must be refused, never rolled over into the next month. */
    it.each(['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10'])('rejects the impossible date %p', (d) => {
      expect(issuesFor(makeAppointment({ appointmentDate: d }))).toContainEqual({ path: 'appointmentDate', message: 'Enter a valid appointment date' });
    });

    it('accepts 29 February in a leap year', () => {
      expect(parseAppointment(makeAppointment({ appointmentDate: '2028-02-29' }))).toMatchObject({ appointmentDate: '2028-02-29' });
    });

    it('rejects 29 February in a non-leap year', () => {
      expect(issuesFor(makeAppointment({ appointmentDate: '2027-02-29' }))).toContainEqual({ path: 'appointmentDate', message: 'Enter a valid appointment date' });
    });

    /** A past date is a real correction, not an error: bookings get entered late. */
    it('accepts a date in the past', () => {
      expect(parseAppointment(makeAppointment({ appointmentDate: '2019-01-05' }))).toMatchObject({ appointmentDate: '2019-01-05' });
    });
  });

  describe('appointmentTime', () => {
    it.each([undefined, null, '', '   '])('treats %p as no time rather than as an error', (t) => {
      expect(parseAppointment(makeAppointment({ appointmentTime: t }))).toMatchObject({ appointmentTime: null });
    });

    it.each(['00:00', '09:15', '23:59'])('accepts %p', (t) => {
      expect(parseAppointment(makeAppointment({ appointmentTime: t }))).toMatchObject({ appointmentTime: t });
    });

    /** A `time` column reads back as HH:MM:SS; the studio books to the minute. */
    it('drops the seconds a database round-trip adds', () => {
      expect(parseAppointment(makeAppointment({ appointmentTime: '10:30:00' }))).toMatchObject({ appointmentTime: '10:30' });
    });

    it.each(['24:00', '10:60', '7:30', '10.30', 'morning'])('rejects %p', (t) => {
      expect(issuesFor(makeAppointment({ appointmentTime: t }))).toContainEqual({ path: 'appointmentTime', message: 'Enter a valid time' });
    });
  });

  describe('customerName', () => {
    it('is required', () => {
      const body = makeAppointment();
      delete (body as Record<string, unknown>).customerName;
      expect(issuesFor(body)).toContainEqual({ path: 'customerName', message: 'Customer name is required' });
    });

    it('rejects a whitespace-only name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeAppointment({ customerName: '   ' }))).toContainEqual({ path: 'customerName', message: 'Customer name is required' });
    });

    it('trims the stored name', () => {
      expect(parseAppointment(makeAppointment({ customerName: '  Ramesh Patel  ' }))).toMatchObject({ customerName: 'Ramesh Patel' });
    });

    it('accepts a name of exactly 120 characters', () => {
      expect(parseAppointment(makeAppointment({ customerName: 'a'.repeat(120) }))).toMatchObject({ customerName: 'a'.repeat(120) });
    });

    it('rejects a name longer than 120 characters', () => {
      expect(issuesFor(makeAppointment({ customerName: 'a'.repeat(121) }))).toContainEqual({ path: 'customerName', message: 'Customer name cannot exceed 120 characters' });
    });
  });

  describe('mobileNumber', () => {
    it('is required', () => {
      const body = makeAppointment();
      delete (body as Record<string, unknown>).mobileNumber;
      expect(issuesFor(body)).toContainEqual({ path: 'mobileNumber', message: 'Mobile no. is required' });
    });

    it('rejects a whitespace-only number', () => {
      expect(issuesFor(makeAppointment({ mobileNumber: '   ' }))).toContainEqual({ path: 'mobileNumber', message: 'Mobile no. is required' });
    });

    it('rejects a number with no digit in it at all', () => {
      expect(issuesFor(makeAppointment({ mobileNumber: 'call the studio' }))).toContainEqual({ path: 'mobileNumber', message: 'Enter a valid mobile no.' });
    });

    /**
     * No 10-digit-only rule: the requirement does not establish one, and a country prefix,
     * a landline or an operator's own spacing are all real entries.
     */
    it.each(['9876543210', '+91 98765 43210', '98765-43210', '0281 2451234', '+971 50 123 4567'])('accepts %p exactly as typed', (m) => {
      expect(parseAppointment(makeAppointment({ mobileNumber: m }))).toMatchObject({ mobileNumber: m });
    });

    it('trims the stored number', () => {
      expect(parseAppointment(makeAppointment({ mobileNumber: '  9876543210 ' }))).toMatchObject({ mobileNumber: '9876543210' });
    });

    it('rejects a number longer than 30 characters', () => {
      expect(issuesFor(makeAppointment({ mobileNumber: '9'.repeat(31) }))).toContainEqual({ path: 'mobileNumber', message: 'Mobile no. cannot exceed 30 characters' });
    });
  });

  describe('babyName and remark', () => {
    it.each(['babyName', 'remark'])('%s is optional and stores blank as null', (field) => {
      expect(parseAppointment(makeAppointment({ [field]: '  ' }))).toMatchObject({ [field]: null });
    });

    it('trims the baby name', () => {
      expect(parseAppointment(makeAppointment({ babyName: '  Aarav  ' }))).toMatchObject({ babyName: 'Aarav' });
    });

    it('rejects a baby name longer than 120 characters', () => {
      expect(issuesFor(makeAppointment({ babyName: 'a'.repeat(121) }))).toContainEqual({ path: 'babyName', message: 'Baby name cannot exceed 120 characters' });
    });

    it('rejects a remark longer than 500 characters', () => {
      expect(issuesFor(makeAppointment({ remark: 'a'.repeat(501) }))).toContainEqual({ path: 'remark', message: 'Remark cannot exceed 500 characters' });
    });

    it('accepts a remark of exactly 500 characters', () => {
      expect(parseAppointment(makeAppointment({ remark: 'a'.repeat(500) }))).toMatchObject({ remark: 'a'.repeat(500) });
    });
  });
});

describe('normalizeMobile (the search key, never the stored value)', () => {
  /** The three shapes the same customer's number is typed in must all agree. */
  it.each(['9876543210', '+91 98765 43210', '98765-43210', '(98765) 43210', '91 98765 43210'])('reduces %p to the same key', (m) => {
    expect(normalizeMobile(m)).toBe('9876543210');
  });

  it('keeps a number shorter than ten digits exactly as its digits', () => {
    expect(normalizeMobile('245-1234')).toBe('2451234');
  });

  /** Only the last ten digits are kept, which drops a country or trunk prefix. */
  it.each([
    ['0281 2451234', '2812451234'],
    ['+971 50 123 4567', '1501234567'],
  ])('reduces the longer %p to %p', (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'no digits here'])('returns an empty key for %p', (m) => {
    expect(normalizeMobile(m as string | null | undefined)).toBe('');
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Tenant isolation, permission enforcement, the number sequence, the transaction that keeps a
 * failed create from burning a number, and the mobile lookup can only be proved against a real
 * database, so this suite is SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users and
 * appointments, and must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Appointments API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let and: typeof import('drizzle-orm').and;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;
  let allocateDocumentNumber: typeof import('../services/documentNumbers').allocateDocumentNumber;

  const tenantIds: string[] = [];
  let tenantAId = '';
  let tokenA = '';
  let tokenAReadOnly = '';
  let tokenB = '';
  let tenantBAppointmentId = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/appointments', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/appointments/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/appointments/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/appointments${path}`, headers: auth(token) });
  const lookup = (token: string, mobile: string) => app.inject({ method: 'GET', url: `/api/common/lookups/appointments?mobile=${encodeURIComponent(mobile)}`, headers: auth(token) });

  interface Row { id: string; appointmentNumber: number; appointmentDate: string; appointmentTime: string | null; customerName: string; mobileNumber: string; babyName: string | null }
  const created = async (token: string, payload: unknown) => (await post(token, payload)).json().data as Row;
  const numbersOf = (res: Awaited<ReturnType<typeof get>>) => (res.json().data.rows as Row[]).map((r) => r.appointmentNumber);
  /** Unique per test, so one test's rows never satisfy another's search. */
  const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  /** The tenant's appointment counter as it currently stands. */
  const counterOf = async (tenantId: string) => {
    const [row] = await db
      .select({ nextNumber: schema.documentCounters.nextNumber })
      .from(schema.documentCounters)
      .where(and(eq(schema.documentCounters.tenantId, tenantId), eq(schema.documentCounters.documentType, 'appointment')));
    return row?.nextNumber ?? null;
  };

  /** One tenant + one role with the given grants + one user; returns a signed access token. */
  async function seedTenant(name: string, grants: Record<string, string[]>) {
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    const [role] = await db.insert(schema.roles).values({ tenantId: tenant.id, name: `${name} role`, permissions: grants }).returning();
    const [user] = await db
      .insert(schema.users)
      .values({ tenantId: tenant.id, roleId: role.id, firstName: name, lastName: 'Tester', email: `${name}-${Date.now()}@test.local`, passwordHash: 'not-a-real-hash' })
      .returning();
    return { tenantId: tenant.id, token: app.jwt.sign({ sub: user.id, tenantId: tenant.id }) };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0'; // server.ts boots a listener on import; keep it off a real port
    ({ and, eq, inArray } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    ({ allocateDocumentNumber } = await import('../services/documentNumbers'));
    app = await (await import('../server')).buildApp();
    await app.ready();

    const full = { operations_appointments: ['read', 'create', 'update', 'delete'] };
    ({ tenantId: tenantAId, token: tokenA } = await seedTenant('ap-tenant-a', full));
    ({ token: tokenAReadOnly } = await seedTenant('ap-tenant-a-readonly', { operations_appointments: ['read'] }));
    ({ token: tokenB } = await seedTenant('ap-tenant-b', full));

    tenantBAppointmentId = (await created(tokenB, { appointmentDate: '2026-09-23', customerName: 'Tenant B Customer', mobileNumber: '9876543210' })).id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(schema.appointments).where(inArray(schema.appointments.tenantId, tenantIds));
      await db.delete(schema.documentCounters).where(inArray(schema.documentCounters.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('create', () => {
    it('creates an appointment and issues its number', async () => {
      const res = await post(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Create'), mobileNumber: '9811111111' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.appointmentNumber).toBeGreaterThanOrEqual(1);
    });

    it('numbers the next appointment one higher', async () => {
      const first = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Seq'), mobileNumber: '9811111112' });
      const second = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Seq'), mobileNumber: '9811111113' });
      expect(second.appointmentNumber).toBe(first.appointmentNumber + 1);
    });

    /** Each tenant counts on its own — tenant B's first appointment is #1 whatever A has done. */
    it('starts a new tenant at 1', async () => {
      const { token } = await seedTenant('ap-tenant-fresh', { operations_appointments: ['read', 'create'] });
      expect((await created(token, { appointmentDate: '2026-09-23', customerName: 'First Ever', mobileNumber: '9800000000' })).appointmentNumber).toBe(1);
    });

    it('ignores a client-supplied appointment number', async () => {
      const row = await created(tokenA, { appointmentNumber: 9999, appointmentDate: '2026-09-23', customerName: uniqueName('Forced'), mobileNumber: '9811111114' });
      expect(row.appointmentNumber).not.toBe(9999);
    });

    it('stores the mobile exactly as typed', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Format'), mobileNumber: '+91 98765 43299' });
      expect(row.mobileNumber).toBe('+91 98765 43299');
    });

    it('stores the date as given, with no timezone shift', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-01-01', customerName: uniqueName('NewYear'), mobileNumber: '9811111115' });
      expect(row.appointmentDate).toBe('2026-01-01');
    });

    it('accepts an appointment with no time', async () => {
      expect((await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('NoTime'), mobileNumber: '9811111116' })).appointmentTime).toBeNull();
    });

    it('rejects a payload with no customer name', async () => {
      expect((await post(tokenA, { appointmentDate: '2026-09-23', mobileNumber: '9811111117' })).statusCode).toBe(400);
    });

    it('rejects a payload with no mobile number', async () => {
      expect((await post(tokenA, { appointmentDate: '2026-09-23', customerName: 'No Mobile' })).statusCode).toBe(400);
    });

    /**
     * Two bookings for the same customer are two bookings, not a duplicate. Nothing
     * deduplicates by mobile number — Billing is what chooses between them later.
     */
    it('allows many appointments on one mobile number', async () => {
      const name = uniqueName('Repeat');
      const a = await created(tokenA, { appointmentDate: '2026-09-12', customerName: name, mobileNumber: '9822222222' });
      const b = await created(tokenA, { appointmentDate: '2026-12-05', customerName: name, mobileNumber: '9822222222' });
      expect(b.appointmentNumber).not.toBe(a.appointmentNumber);
    });

    /** Nothing models a room, a photographer or a slot, so a clash is not this phase's business. */
    it('allows two appointments at the same date and time', async () => {
      const at = { appointmentDate: '2026-11-11', appointmentTime: '11:00' };
      await created(tokenA, { ...at, customerName: uniqueName('SlotOne'), mobileNumber: '9833333331' });
      expect((await post(tokenA, { ...at, customerName: uniqueName('SlotTwo'), mobileNumber: '9833333332' })).statusCode).toBe(200);
    });
  });

  describe('numbering', () => {
    /**
     * The allocator runs inside the caller's transaction, so a create that fails afterwards
     * rolls the counter back with it instead of burning a number.
     */
    it('does not consume a number when the surrounding transaction fails', async () => {
      const before = await counterOf(tenantAId);
      await expect(
        db.transaction(async (tx) => {
          await allocateDocumentNumber(tx, tenantAId, 'appointment');
          throw new Error('rolled back on purpose');
        }),
      ).rejects.toThrow('rolled back on purpose');
      expect(await counterOf(tenantAId)).toBe(before);
    });

    /** The UI has one operator; the database must still be right when it does not. */
    it('gives 25 simultaneous creates 25 distinct numbers', async () => {
      const { token } = await seedTenant('ap-tenant-race', { operations_appointments: ['read', 'create'] });
      const rows = await Promise.all(
        Array.from({ length: 25 }, (_, i) => created(token, { appointmentDate: '2026-09-23', customerName: `Race ${i}`, mobileNumber: `98444444${String(i).padStart(2, '0')}` })),
      );
      const numbers = rows.map((r) => r.appointmentNumber).sort((a, b) => a - b);
      expect(new Set(numbers).size).toBe(25);
      expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    /** Appointment numbering and Book bill numbering are unrelated sequences. */
    it('never touches a book bill counter', async () => {
      const [book] = await db.insert(schema.books).values({ tenantId: tenantAId, bookNumber: uniqueName('BK'), seriesStartsAt: 1, nextBillNumber: 1 }).returning();
      await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('NoBook'), mobileNumber: '9855555555' });
      const [after] = await db.select().from(schema.books).where(eq(schema.books.id, book.id));
      expect(after.nextBillNumber).toBe(1);
      await db.delete(schema.books).where(eq(schema.books.id, book.id));
    });
  });

  describe('read, update and delete', () => {
    it('reads one appointment back', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Read'), mobileNumber: '9866666661' });
      const res = await get(tokenA, `/${row.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(row.id);
    });

    it('updates the business fields', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Edit'), mobileNumber: '9866666662' });
      const res = await put(tokenA, row.id, { appointmentTime: '15:45', babyName: 'Ishaan', remark: 'Rescheduled' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ appointmentTime: '15:45', babyName: 'Ishaan', remark: 'Rescheduled' });
    });

    it('re-derives the search key when the mobile number is edited', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Renumber'), mobileNumber: '9877777771' });
      await put(tokenA, row.id, { mobileNumber: '+91 98777 77772' });
      const found = (await lookup(tokenA, '9877777772')).json().data as Row[];
      expect(found.map((r) => r.id)).toContain(row.id);
      expect(((await lookup(tokenA, '9877777771')).json().data as Row[]).map((r) => r.id)).not.toContain(row.id);
    });

    it('cannot change the appointment number', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Immutable'), mobileNumber: '9866666663' });
      await put(tokenA, row.id, { appointmentNumber: 4242, babyName: 'Anaya' });
      expect((await get(tokenA, `/${row.id}`)).json().data.appointmentNumber).toBe(row.appointmentNumber);
    });

    it('deletes an appointment', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Doomed'), mobileNumber: '9866666664' });
      expect((await del(tokenA, row.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${row.id}`)).statusCode).toBe(404);
    });
  });

  describe('list', () => {
    it('finds an appointment by its exact number', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('ByNumber'), mobileNumber: '9888888881' });
      expect(numbersOf(await get(tokenA, `?search=${row.appointmentNumber}`))).toEqual([row.appointmentNumber]);
    });

    it('finds an appointment by customer name', async () => {
      const name = uniqueName('Nandini');
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: name, mobileNumber: '9888888882' });
      expect(numbersOf(await get(tokenA, `?search=${name}`))).toEqual([row.appointmentNumber]);
    });

    it('finds an appointment by baby name', async () => {
      const baby = uniqueName('Vivaan');
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Parent'), mobileNumber: '9888888883', babyName: baby });
      expect(numbersOf(await get(tokenA, `?search=${baby}`))).toEqual([row.appointmentNumber]);
    });

    /** However the number was typed, and however it is searched for. */
    it.each(['9899999991', '+91 98999 99991', '98999-99991'])('finds an appointment searching the mobile as %p', async (term) => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Mobile'), mobileNumber: '98999 99991' });
      expect(numbersOf(await get(tokenA, `?search=${encodeURIComponent(term)}`))).toContain(row.appointmentNumber);
      await del(tokenA, row.id);
    });

    /**
     * Regression: a twelve-digit mobile typed into the search box is all digits, but comparing
     * it to the `integer` appointment number asks Postgres to cast out of range and fails the
     * whole request. It must be treated as a phone number instead.
     */
    it('survives a digit string larger than the appointment number column holds', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Long'), mobileNumber: '+91 98765 43277' });
      const res = await get(tokenA, '?search=919876543277');
      expect(res.statusCode).toBe(200);
      expect(numbersOf(res)).toContain(row.appointmentNumber);
    });

    it('filters by appointment date', async () => {
      const row = await created(tokenA, { appointmentDate: '2029-07-04', customerName: uniqueName('Dated'), mobileNumber: '9890000001' });
      const filters = encodeURIComponent(JSON.stringify([{ field: 'appointmentDate', op: 'equals', value: '2029-07-04' }]));
      expect(numbersOf(await get(tokenA, `?filters=${filters}`))).toEqual([row.appointmentNumber]);
    });

    it('filters by a date range', async () => {
      const inside = await created(tokenA, { appointmentDate: '2030-03-15', customerName: uniqueName('Inside'), mobileNumber: '9890000002' });
      const outside = await created(tokenA, { appointmentDate: '2030-05-15', customerName: uniqueName('Outside'), mobileNumber: '9890000003' });
      const filters = encodeURIComponent(JSON.stringify([{ field: 'appointmentDate', op: 'between', value: ['2030-03-01', '2030-03-31'] }]));
      const found = numbersOf(await get(tokenA, `?filters=${filters}`));
      expect(found).toContain(inside.appointmentNumber);
      expect(found).not.toContain(outside.appointmentNumber);
    });

    /** Daily work reads newest first: latest date, latest time within the day, newest number. */
    it('defaults to the most recent appointment first', async () => {
      const { token } = await seedTenant('ap-tenant-order', { operations_appointments: ['read', 'create'] });
      const early = await created(token, { appointmentDate: '2031-01-10', appointmentTime: '09:00', customerName: 'Early', mobileNumber: '9891000001' });
      const late = await created(token, { appointmentDate: '2031-01-10', appointmentTime: '17:00', customerName: 'Late', mobileNumber: '9891000002' });
      const next = await created(token, { appointmentDate: '2031-02-01', customerName: 'NextMonth', mobileNumber: '9891000003' });
      const untimed = await created(token, { appointmentDate: '2031-01-10', customerName: 'NoTime', mobileNumber: '9891000004' });
      expect(numbersOf(await app.inject({ method: 'GET', url: '/api/appointments', headers: auth(token) }))).toEqual([
        next.appointmentNumber,
        late.appointmentNumber,
        early.appointmentNumber,
        untimed.appointmentNumber,
      ]);
    });

    it('paginates without repeating or dropping a row', async () => {
      const { token } = await seedTenant('ap-tenant-page', { operations_appointments: ['read', 'create'] });
      for (let i = 0; i < 5; i++) await created(token, { appointmentDate: '2032-01-0' + (i + 1), customerName: `Page ${i}`, mobileNumber: `989200000${i}` });
      const first = numbersOf(await app.inject({ method: 'GET', url: '/api/appointments?page=1&limit=2', headers: auth(token) }));
      const second = numbersOf(await app.inject({ method: 'GET', url: '/api/appointments?page=2&limit=2', headers: auth(token) }));
      expect(first).toHaveLength(2);
      expect(new Set([...first, ...second]).size).toBe(4);
    });

    it("never shows another tenant's appointments", async () => {
      const rows = (await get(tokenA)).json().data.rows as { id: string }[];
      expect(rows.map((r) => r.id)).not.toContain(tenantBAppointmentId);
    });

    it("returns 404 for another tenant's appointment", async () => {
      expect((await get(tokenA, `/${tenantBAppointmentId}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's appointment", async () => {
      expect((await put(tokenA, tenantBAppointmentId, { babyName: 'Hijacked' })).statusCode).toBe(404);
    });

    it("cannot delete another tenant's appointment", async () => {
      expect((await del(tokenA, tenantBAppointmentId)).statusCode).toBe(404);
    });
  });

  describe('permissions', () => {
    it('lets a read-only user list appointments', async () => {
      expect((await get(tokenAReadOnly)).statusCode).toBe(200);
    });

    it('refuses a create without the create action', async () => {
      expect((await post(tokenAReadOnly, { appointmentDate: '2026-09-23', customerName: 'Denied', mobileNumber: '9801010101' })).statusCode).toBe(403);
    });

    it('refuses an update without the update action', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Guarded'), mobileNumber: '9801010102' });
      expect((await put(tokenAReadOnly, row.id, { babyName: 'Nope' })).statusCode).toBe(403);
    });

    it('refuses a delete without the delete action', async () => {
      const row = await created(tokenA, { appointmentDate: '2026-09-23', customerName: uniqueName('Guarded'), mobileNumber: '9801010103' });
      expect((await del(tokenAReadOnly, row.id)).statusCode).toBe(403);
    });

    it('refuses an unauthenticated request', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/appointments' })).statusCode).toBe(401);
    });
  });

  /** The contract the future Billing screen will use. It is NOT Billing. */
  describe('mobile lookup for Billing', () => {
    const MOBILE = '9812345678';
    let tokenL = '';
    let older: Row;
    let newer: Row;

    beforeAll(async () => {
      ({ token: tokenL } = await seedTenant('ap-tenant-lookup', { operations_appointments: ['read', 'create'] }));
      older = await created(tokenL, { appointmentDate: '2026-09-12', appointmentTime: '10:30', customerName: 'Ramesh Patel', mobileNumber: MOBILE, babyName: 'Aarav' });
      newer = await created(tokenL, { appointmentDate: '2026-12-05', appointmentTime: '16:00', customerName: 'Ramesh Patel', mobileNumber: `+91 ${MOBILE.slice(0, 5)} ${MOBILE.slice(5)}`, babyName: 'Aarav' });
    });

    it.each(['9812345678', '+91 98123 45678', '98123-45678'])('finds the same candidates for %p', async (term) => {
      const rows = (await lookup(tokenL, term)).json().data as Row[];
      expect(rows.map((r) => r.id).sort()).toEqual([older.id, newer.id].sort());
    });

    /** Many bookings on one number is normal — the API offers them, it does not choose. */
    it('returns every candidate, most recent first', async () => {
      const rows = (await lookup(tokenL, MOBILE)).json().data as Row[];
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(newer.id);
    });

    it('returns only the fields Billing needs, and no internal ones', async () => {
      const [row] = (await lookup(tokenL, MOBILE)).json().data as Record<string, unknown>[];
      expect(Object.keys(row).sort()).toEqual(['appointmentDate', 'appointmentNumber', 'appointmentTime', 'babyName', 'customerName', 'id', 'mobileNumber'].sort());
      expect(row).not.toHaveProperty('mobileSearch');
      expect(row).not.toHaveProperty('tenantId');
    });

    it('returns nothing for a blank mobile rather than the whole table', async () => {
      expect((await lookup(tokenL, '')).json().data).toEqual([]);
    });

    it('returns nothing for a number nobody booked with', async () => {
      expect((await lookup(tokenL, '9000000009')).json().data).toEqual([]);
    });

    /** Tenant B booked the same number in beforeAll; it must stay invisible here. */
    it("never returns another tenant's appointment", async () => {
      const rows = (await lookup(tokenA, '9876543210')).json().data as Row[];
      expect(rows.map((r) => r.id)).not.toContain(tenantBAppointmentId);
    });

    it('refuses an unauthenticated lookup', async () => {
      expect((await app.inject({ method: 'GET', url: `/api/common/lookups/appointments?mobile=${MOBILE}` })).statusCode).toBe(401);
    });

    it('refuses a lookup from a user without appointment read permission', async () => {
      const { token } = await seedTenant('ap-tenant-nogrant', { masters_books: ['read'] });
      expect((await lookup(token, MOBILE)).statusCode).toBe(403);
    });
  });
});
