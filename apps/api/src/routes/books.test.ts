import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { bookSchema } from '@erp/shared';

/**
 * Book Master — a book is one independent bill number series.
 *
 * Section A is pure validation — no database, always runs. Section B needs a database and is
 * skipped unless TEST_DATABASE_URL is set; it is where the duplicate guard, tenant isolation,
 * permission enforcement, the counter's initialisation and the concurrency of the allocator
 * live.
 *
 * Bills themselves do not exist in this phase. The tests therefore exercise the numbering
 * PRIMITIVE (`allocateBillNumber`) directly rather than inventing fake bills to drive it;
 * wiring it into bill creation belongs to the Billing phase.
 */

/* --------------------------------------------------------------- helpers -- */

/** Minimal valid Book payload; override only what the test is about. */
const makeBook = (overrides: Record<string, unknown> = {}) => ({
  bookNumber: '2026-27',
  ...overrides,
});

const parseBook = (input: unknown, schema: ZodTypeAny = bookSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = bookSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('bookSchema (create payload)', () => {
  it('accepts a valid book and trims the number', () => {
    expect(parseBook(makeBook({ bookNumber: '  2026-27  ' }))).toEqual({ bookNumber: '2026-27', seriesStartsAt: 1, isActive: true });
  });

  it('defaults a new book to active when isActive is omitted', () => {
    expect(parseBook(makeBook())).toMatchObject({ isActive: true });
  });

  it('keeps an explicit isActive:false', () => {
    expect(parseBook(makeBook({ isActive: false }))).toMatchObject({ isActive: false });
  });

  /**
   * The counter is system-managed. zod strips unknown keys, so a payload that tries to set it
   * loses the field entirely before any route code runs.
   */
  it('silently drops a client-supplied nextBillNumber', () => {
    expect(parseBook(makeBook({ nextBillNumber: 9999 }))).not.toHaveProperty('nextBillNumber');
  });

  describe('bookNumber', () => {
    it('is required', () => {
      const body = makeBook();
      delete (body as Record<string, unknown>).bookNumber;
      expect(issuesFor(body)).toContainEqual({ path: 'bookNumber', message: 'Required' });
    });

    it('rejects an empty book number', () => {
      expect(issuesFor(makeBook({ bookNumber: '' }))).toContainEqual({ path: 'bookNumber', message: 'Book number is required' });
    });

    it('rejects a whitespace-only book number, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeBook({ bookNumber: '   ' }))).toContainEqual({ path: 'bookNumber', message: 'Book number is required' });
    });

    it('accepts a book number of exactly 60 characters', () => {
      expect(parseBook(makeBook({ bookNumber: 'a'.repeat(60) }))).toMatchObject({ bookNumber: 'a'.repeat(60) });
    });

    it('rejects a book number longer than 60 characters', () => {
      expect(issuesFor(makeBook({ bookNumber: 'a'.repeat(61) }))).toContainEqual({ path: 'bookNumber', message: 'Book number cannot exceed 60 characters' });
    });

    /**
     * The naming convention is the business's to change. "2026-27" is only today's habit, so
     * nothing may enforce YYYY-YY.
     */
    it.each(['2026-27', 'BOOK-A', 'Studio/2026', '1', 'दीवाली 2026'])('accepts %p, because the format is the business’s choice', (n) => {
      expect(parseBook(makeBook({ bookNumber: n }))).toMatchObject({ bookNumber: n });
    });
  });

  describe('seriesStartsAt', () => {
    it('defaults to 1 when omitted', () => {
      expect(parseBook(makeBook())).toMatchObject({ seriesStartsAt: 1 });
    });

    it('accepts a custom start', () => {
      expect(parseBook(makeBook({ seriesStartsAt: 1001 }))).toMatchObject({ seriesStartsAt: 1001 });
    });

    it('accepts a numeric string, as an HTML form posts it', () => {
      expect(parseBook(makeBook({ seriesStartsAt: '1001' }))).toMatchObject({ seriesStartsAt: 1001 });
    });

    it('rejects 0, which is not a bill number', () => {
      expect(issuesFor(makeBook({ seriesStartsAt: 0 }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at must be at least 1' });
    });

    it('rejects a negative start', () => {
      expect(issuesFor(makeBook({ seriesStartsAt: -5 }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at must be at least 1' });
    });

    it('rejects a decimal start', () => {
      expect(issuesFor(makeBook({ seriesStartsAt: 1.5 }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at must be a whole number' });
    });

    /**
     * The trap `z.coerce.number()` falls into: '', null and [] all become 0, and a book that
     * silently started at 0 would be wrong rather than rejected.
     */
    it.each([['empty string', ''], ['whitespace', '   '], ['null', null], ['empty array', []]])('rejects %s rather than coercing it to a number', (_label, v) => {
      expect(issuesFor(makeBook({ seriesStartsAt: v }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at is required' });
    });

    it('rejects text that is not a number', () => {
      expect(issuesFor(makeBook({ seriesStartsAt: 'abc' }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at must be a number' });
    });

    it('rejects a start past the supported ceiling', () => {
      expect(issuesFor(makeBook({ seriesStartsAt: 1_000_000_001 }))).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at is too large' });
    });
  });
});

/**
 * PUT goes through `bookSchema.partial()` (see lib/crud.ts). Absent fields must stay absent —
 * an update that re-applied the `seriesStartsAt` default would rewrite a book's series start
 * to 1 every time someone renamed it.
 */
describe('bookSchema.partial() (update payload)', () => {
  const partial = bookSchema.partial();

  it('accepts an empty patch', () => {
    expect(parseBook({}, partial)).toEqual({});
  });

  it('does not re-apply the seriesStartsAt default, so renaming a book leaves its series alone', () => {
    expect(parseBook({ bookNumber: '2027-28' }, partial)).toEqual({ bookNumber: '2027-28' });
  });

  it('does not re-apply the isActive default, so editing an inactive book leaves it inactive', () => {
    expect(parseBook({ bookNumber: '2027-28' }, partial)).not.toHaveProperty('isActive');
  });

  it('still drops a client-supplied nextBillNumber', () => {
    expect(parseBook({ nextBillNumber: 1 }, partial)).toEqual({});
  });

  it('still trims a book number that is present', () => {
    expect(parseBook({ bookNumber: '  2027-28  ' }, partial)).toEqual({ bookNumber: '2027-28' });
  });

  it('still rejects a blanked-out book number', () => {
    expect(issuesFor({ bookNumber: '   ' }, partial)).toContainEqual({ path: 'bookNumber', message: 'Book number is required' });
  });

  it('still rejects an invalid series start', () => {
    expect(issuesFor({ seriesStartsAt: 0 }, partial)).toContainEqual({ path: 'seriesStartsAt', message: 'Series starts at must be at least 1' });
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Tenant isolation, permission enforcement, the duplicate guard, the counter's initialisation
 * and the allocator's concurrency can only be proved against a real database, so this suite is
 * SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users and
 * books, and must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Book Master API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;
  let allocateBillNumber: typeof import('../services/billNumbers').allocateBillNumber;

  const tenantIds: string[] = [];
  let tenantAId = '';
  let tokenA = '';
  let tokenAReadOnly = '';
  let tokenB = '';
  let tenantBBookId = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/masters/books', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/masters/books/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/masters/books/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/masters/books${path}`, headers: auth(token) });
  /** Creates a book and returns the row the API echoed back. */
  const created = async (token: string, payload: unknown) => (await post(token, payload)).json().data as { id: string; seriesStartsAt: number; nextBillNumber: number };
  /** Unique per test, so the case-insensitive unique index never collides across cases. */
  const uniqueNumber = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

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
    inArray = (await import('drizzle-orm')).inArray;
    const client = await import('../db/client');
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    ({ allocateBillNumber } = await import('../services/billNumbers'));
    app = await (await import('../server')).buildApp();
    await app.ready();

    const full = { masters_books: ['read', 'create', 'update', 'delete'] };
    ({ tenantId: tenantAId, token: tokenA } = await seedTenant('bk-tenant-a', full));
    ({ token: tokenAReadOnly } = await seedTenant('bk-tenant-a-readonly', { masters_books: ['read'] }));
    ({ token: tokenB } = await seedTenant('bk-tenant-b', full));

    tenantBBookId = (await created(tokenB, { bookNumber: 'TENANT B 2026-27' })).id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(schema.books).where(inArray(schema.books.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('create', () => {
    it('creates a book that is active by default', async () => {
      const res = await post(tokenA, { bookNumber: uniqueNumber('CREATE') });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ isActive: true });
    });

    it('rejects a payload with no book number', async () => {
      expect((await post(tokenA, {})).statusCode).toBe(400);
    });

    it('rejects a blank book number', async () => {
      expect((await post(tokenA, { bookNumber: '   ' })).statusCode).toBe(400);
    });

    it.each([0, -1, 1.5, '', null])('rejects a series starting at %p', async (v) => {
      expect((await post(tokenA, { bookNumber: uniqueNumber('BAD START'), seriesStartsAt: v })).statusCode).toBe(400);
    });
  });

  /** Where a book's series begins, and the counter that follows from it. */
  describe('series counter initialisation', () => {
    it('starts the counter at 1 when the series starts at 1', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('START 1'), seriesStartsAt: 1 });
      expect(row).toMatchObject({ seriesStartsAt: 1, nextBillNumber: 1 });
    });

    it('starts the counter at 1 when the series start is omitted', async () => {
      expect(await created(tokenA, { bookNumber: uniqueNumber('START DEFAULT') })).toMatchObject({ seriesStartsAt: 1, nextBillNumber: 1 });
    });

    it('starts the counter at 1001 when the series starts at 1001', async () => {
      expect(await created(tokenA, { bookNumber: uniqueNumber('START 1001'), seriesStartsAt: 1001 })).toMatchObject({ seriesStartsAt: 1001, nextBillNumber: 1001 });
    });

    it('ignores a nextBillNumber sent by the client and uses the series start instead', async () => {
      expect(await created(tokenA, { bookNumber: uniqueNumber('FORGED'), seriesStartsAt: 5, nextBillNumber: 9999 })).toMatchObject({ nextBillNumber: 5 });
    });
  });

  describe('update', () => {
    it('renames a book without moving its counter', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('RENAME'), seriesStartsAt: 50 });
      const res = await put(tokenA, row.id, { bookNumber: uniqueNumber('RENAMED') });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ seriesStartsAt: 50, nextBillNumber: 50 });
    });

    it('deactivates a book without moving its counter', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('DEACTIVATE'), seriesStartsAt: 7 });
      expect((await put(tokenA, row.id, { isActive: false })).json().data).toMatchObject({ isActive: false, nextBillNumber: 7 });
    });

    it('ignores a nextBillNumber sent by the client', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('NO FORGE'), seriesStartsAt: 3 });
      expect((await put(tokenA, row.id, { nextBillNumber: 900 })).json().data).toMatchObject({ nextBillNumber: 3 });
    });

    /** Correcting a typo before anything has been issued is legitimate — and moves the counter with it. */
    it('lets the series start be corrected while the book has issued nothing', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('CORRECT'), seriesStartsAt: 1 });
      expect((await put(tokenA, row.id, { seriesStartsAt: 500 })).json().data).toMatchObject({ seriesStartsAt: 500, nextBillNumber: 500 });
    });

    it('refuses to change the series start once the book has issued a number', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('LOCKED'), seriesStartsAt: 1 });
      await allocateBillNumber(db, tenantAId, row.id);
      const res = await put(tokenA, row.id, { seriesStartsAt: 900 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('cannot be changed once this book has issued bill numbers');
    });

    it('still allows renaming a book whose series is locked, without disturbing the counter', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('LOCKED RENAME'), seriesStartsAt: 10 });
      await allocateBillNumber(db, tenantAId, row.id);
      const res = await put(tokenA, row.id, { bookNumber: uniqueNumber('LOCKED RENAMED') });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ seriesStartsAt: 10, nextBillNumber: 11 });
    });

    /** Resubmitting the unchanged value is not an edit and must not be treated as one. */
    it('accepts an unchanged series start on a locked book', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('SAME START'), seriesStartsAt: 20 });
      await allocateBillNumber(db, tenantAId, row.id);
      expect((await put(tokenA, row.id, { seriesStartsAt: 20 })).statusCode).toBe(200);
    });
  });

  /**
   * The numbering primitive. Bills do not exist yet, so these drive the allocator directly —
   * consuming a number as part of bill creation is the Billing phase's job.
   */
  describe('bill number allocation', () => {
    it('hands out the series start first, then counts up', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('SEQUENCE'), seriesStartsAt: 1 });
      expect(await allocateBillNumber(db, tenantAId, row.id)).toBe(1);
      expect(await allocateBillNumber(db, tenantAId, row.id)).toBe(2);
      expect(await allocateBillNumber(db, tenantAId, row.id)).toBe(3);
    });

    it('counts up from a custom start', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('CUSTOM SEQUENCE'), seriesStartsAt: 1001 });
      expect(await allocateBillNumber(db, tenantAId, row.id)).toBe(1001);
      expect(await allocateBillNumber(db, tenantAId, row.id)).toBe(1002);
    });

    /** The whole point of Book Master: a new book is a new series, not a continuation. */
    it('numbers each book independently, so two books can both issue Bill No. 1', async () => {
      const bookA = await created(tokenA, { bookNumber: uniqueNumber('2026-27'), seriesStartsAt: 1 });
      const bookB = await created(tokenA, { bookNumber: uniqueNumber('2027-28'), seriesStartsAt: 1 });
      await allocateBillNumber(db, tenantAId, bookA.id);
      await allocateBillNumber(db, tenantAId, bookA.id);
      expect(await allocateBillNumber(db, tenantAId, bookA.id)).toBe(3);
      expect(await allocateBillNumber(db, tenantAId, bookB.id)).toBe(1);
    });

    it("refuses to allocate from another tenant's book", async () => {
      await expect(allocateBillNumber(db, tenantAId, tenantBBookId)).rejects.toThrow(/not found/i);
    });

    /**
     * Two operators billing at the same instant. The allocation is a single
     * `UPDATE ... RETURNING`, so Postgres serialises them on the book row — no number can be
     * handed out twice, and none can be skipped.
     */
    it('never hands the same number to two concurrent callers', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('CONCURRENT'), seriesStartsAt: 1 });
      const numbers = await Promise.all(Array.from({ length: 25 }, () => allocateBillNumber(db, tenantAId, row.id)));
      expect(new Set(numbers).size).toBe(25);
      expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it('keeps concurrent allocations on different books in their own series', async () => {
      const bookA = await created(tokenA, { bookNumber: uniqueNumber('PARALLEL A'), seriesStartsAt: 1 });
      const bookB = await created(tokenA, { bookNumber: uniqueNumber('PARALLEL B'), seriesStartsAt: 1 });
      const pairs = await Promise.all(
        Array.from({ length: 10 }, (_, i) => allocateBillNumber(db, tenantAId, i % 2 === 0 ? bookA.id : bookB.id)),
      );
      expect([...pairs].sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    });
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/masters/books' })).statusCode).toBe(401);
    });

    it('refuses to create for a role granted only read on masters_books', async () => {
      const res = await post(tokenAReadOnly, { bookNumber: uniqueNumber('SHOULD NOT EXIST') });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('create permission for masters_books');
    });

    it('refuses to update for a role granted only read', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('GUARDED UPDATE') });
      expect((await put(tokenAReadOnly, row.id, { isActive: false })).statusCode).toBe(403);
    });

    it('refuses to delete for a role granted only read', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('GUARDED DELETE') });
      expect((await del(tokenAReadOnly, row.id)).statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another tenant's book by id", async () => {
      expect((await get(tokenA, `/${tenantBBookId}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's book", async () => {
      expect((await put(tokenA, tenantBBookId, { bookNumber: 'HIJACKED' })).statusCode).toBe(404);
    });

    it("cannot delete another tenant's book", async () => {
      expect((await del(tokenA, tenantBBookId)).statusCode).toBe(404);
    });

    it("never lists another tenant's books", async () => {
      const rows = (await get(tokenA, '?limit=100')).json().data.rows as { id: string }[];
      expect(rows.some((r) => r.id === tenantBBookId)).toBe(false);
    });

    it('keeps the lookup tenant-scoped too', async () => {
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/books', headers: auth(tokenA) })).json().data as { id: string }[];
      expect(rows.some((r) => r.id === tenantBBookId)).toBe(false);
    });
  });

  describe('duplicate book numbers', () => {
    it('refuses a second book with the same number in the same tenant', async () => {
      const n = uniqueNumber('DUP');
      await post(tokenA, { bookNumber: n });
      const res = await post(tokenA, { bookNumber: n });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(`A book named "${n}" already exists`);
    });

    it('treats book numbers case-insensitively', async () => {
      const n = uniqueNumber('CaseBook');
      await post(tokenA, { bookNumber: n });
      expect((await post(tokenA, { bookNumber: n.toUpperCase() })).statusCode).toBe(400);
    });

    it('allows the same book number in a different tenant', async () => {
      const n = uniqueNumber('SHARED');
      await post(tokenA, { bookNumber: n });
      expect((await post(tokenB, { bookNumber: n })).statusCode).toBe(200);
    });

    it('lets a book keep its own number when it is updated', async () => {
      const n = uniqueNumber('KEEPS NAME');
      const row = await created(tokenA, { bookNumber: n });
      expect((await put(tokenA, row.id, { bookNumber: n, isActive: false })).statusCode).toBe(200);
    });

    it("refuses to rename a book onto another book's number", async () => {
      const taken = uniqueNumber('TAKEN');
      await post(tokenA, { bookNumber: taken });
      const other = await created(tokenA, { bookNumber: uniqueNumber('OTHER') });
      expect((await put(tokenA, other.id, { bookNumber: taken.toLowerCase() })).statusCode).toBe(400);
    });
  });

  describe('list', () => {
    it('searches by book number', async () => {
      const n = uniqueNumber('SEARCHABLE');
      await post(tokenA, { bookNumber: n });
      const rows = (await get(tokenA, `?search=${encodeURIComponent(n)}`)).json().data.rows as { bookNumber: string }[];
      expect(rows.some((r) => r.bookNumber === n)).toBe(true);
    });

    it('filters by status', async () => {
      await post(tokenA, { bookNumber: uniqueNumber('INACTIVE FILTER'), isActive: false });
      const rows = (await get(tokenA, '?isActive=false&limit=100')).json().data.rows as { isActive: boolean }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.isActive === false)).toBe(true);
    });

    it('reports a total that matches the filter, not the whole table', async () => {
      const page = (await get(tokenA, '?isActive=false&limit=1')).json().data as { rows: unknown[]; total: number };
      const all = (await get(tokenA, '?isActive=false&limit=100')).json().data.rows as unknown[];
      expect(page.rows).toHaveLength(1);
      expect(page.total).toBe(all.length);
    });

    it('sorts by book number when asked to', async () => {
      const res = await get(tokenA, '?sortBy=bookNumber&sortOrder=asc&limit=100');
      const rows = res.json().data.rows as { bookNumber: string }[];
      expect([...rows].map((r) => r.bookNumber)).toEqual([...rows].map((r) => r.bookNumber).sort());
    });
  });

  describe('lookup', () => {
    it('returns only active books, with just the fields a picker needs', async () => {
      const active = uniqueNumber('LOOKUP ACTIVE');
      await post(tokenA, { bookNumber: active });
      const inactive = await created(tokenA, { bookNumber: uniqueNumber('LOOKUP INACTIVE'), isActive: false });
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/books', headers: auth(tokenA) })).json().data as Record<string, unknown>[];
      expect(rows.some((r) => r.bookNumber === active)).toBe(true);
      expect(rows.some((r) => r.id === inactive.id)).toBe(false);
    });

    /** The counter is not a value a generic picker has any business carrying around. */
    it('never exposes the counter through the lookup', async () => {
      await post(tokenA, { bookNumber: uniqueNumber('LOOKUP SHAPE') });
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/books', headers: auth(tokenA) })).json().data as Record<string, unknown>[];
      expect(Object.keys(rows[0]).sort()).toEqual(['bookNumber', 'id']);
    });
  });

  describe('delete', () => {
    it('deletes a book', async () => {
      const row = await created(tokenA, { bookNumber: uniqueNumber('DELETABLE') });
      expect((await del(tokenA, row.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${row.id}`)).statusCode).toBe(404);
    });
  });
});
