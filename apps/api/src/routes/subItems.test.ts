import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { SUB_ITEM_RATE_MAX, subItemSchema } from '@erp/shared';

/**
 * Sub Item Master.
 *
 * Section A is pure validation — no database, always runs. Section B needs a database and is
 * skipped unless TEST_DATABASE_URL is set; it is where the relationship to Item Master lives
 * (parent existence, cross-tenant rejection, the per-item duplicate rule and rate round-trip).
 */

/* --------------------------------------------------------------- helpers -- */

const ITEM_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** Minimal valid Sub Item payload; override only what the test is about. */
const makeSubItem = (overrides: Record<string, unknown> = {}) => ({
  itemId: ITEM_ID,
  productName: 'Wedding Shoot',
  rate: 2500,
  ...overrides,
});

const parseSubItem = (input: unknown, schema: ZodTypeAny = subItemSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = subItemSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('subItemSchema (create payload)', () => {
  it('accepts a valid sub item, trims the product name and defaults remark to null', () => {
    expect(parseSubItem(makeSubItem({ productName: '  Wedding Shoot  ' }))).toEqual({
      itemId: ITEM_ID,
      productName: 'Wedding Shoot',
      rate: 2500,
      remark: null,
      isActive: true,
    });
  });

  it('defaults a new sub item to active when isActive is omitted', () => {
    expect(parseSubItem(makeSubItem())).toMatchObject({ isActive: true });
  });

  it('keeps an explicit isActive:false', () => {
    expect(parseSubItem(makeSubItem({ isActive: false }))).toMatchObject({ isActive: false });
  });

  /**
   * GST % and HSN belong to Item Master and must not be duplicated here. zod strips unknown
   * keys, so a client that posts them cannot create a second, divergent copy of the tax data.
   */
  it('drops gstRate and hsnCode — tax data lives on the parent item, never on the product', () => {
    const parsed = parseSubItem(makeSubItem({ gstRate: 18, hsnCode: '998383' })) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('gstRate');
    expect(parsed).not.toHaveProperty('hsnCode');
  });

  describe('itemId', () => {
    it('is required', () => {
      const body = makeSubItem();
      delete (body as Record<string, unknown>).itemId;
      expect(issuesFor(body)).toContainEqual({ path: 'itemId', message: 'Item is required' });
    });

    it('rejects an empty selection', () => {
      expect(issuesFor(makeSubItem({ itemId: '' }))).toContainEqual({ path: 'itemId', message: 'Item is required' });
    });

    it('rejects a value that is not a uuid, so a free-typed item name never reaches the database', () => {
      expect(issuesFor(makeSubItem({ itemId: 'Photography' }))).toContainEqual({ path: 'itemId', message: 'Select a valid item' });
    });
  });

  describe('productName', () => {
    it('is required', () => {
      const body = makeSubItem();
      delete (body as Record<string, unknown>).productName;
      expect(issuesFor(body)).toContainEqual({ path: 'productName', message: 'Required' });
    });

    it('rejects an empty product name', () => {
      expect(issuesFor(makeSubItem({ productName: '' }))).toContainEqual({ path: 'productName', message: 'Product name is required' });
    });

    it('rejects a whitespace-only product name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeSubItem({ productName: '   ' }))).toContainEqual({ path: 'productName', message: 'Product name is required' });
    });

    it('accepts a product name of exactly 120 characters', () => {
      expect(parseSubItem(makeSubItem({ productName: 'a'.repeat(120) }))).toMatchObject({ productName: 'a'.repeat(120) });
    });

    it('rejects a product name longer than 120 characters', () => {
      expect(issuesFor(makeSubItem({ productName: 'a'.repeat(121) }))).toContainEqual({
        path: 'productName',
        message: 'Product name cannot exceed 120 characters',
      });
    });
  });

  describe('rate', () => {
    it.each([0, 100, 500, 1250.5, 2500, 9999.99])('accepts %p', (rate) => {
      expect(parseSubItem(makeSubItem({ rate }))).toMatchObject({ rate });
    });

    it('accepts zero — a complimentary product is a real price, not a missing one', () => {
      expect(parseSubItem(makeSubItem({ rate: 0 }))).toMatchObject({ rate: 0 });
    });

    it('accepts a numeric string from a form and coerces it to a number', () => {
      const parsed = parseSubItem(makeSubItem({ rate: '1250.50' })) as { rate: number };
      expect(parsed.rate).toBe(1250.5);
      expect(typeof parsed.rate).toBe('number');
    });

    it('is required', () => {
      const body = makeSubItem();
      delete (body as Record<string, unknown>).rate;
      expect(issuesFor(body)).toContainEqual({ path: 'rate', message: 'Rate is required' });
    });

    it('rejects a negative rate', () => {
      expect(issuesFor(makeSubItem({ rate: -1 }))).toContainEqual({ path: 'rate', message: 'Rate cannot be negative' });
    });

    it('rejects non-numeric text', () => {
      expect(issuesFor(makeSubItem({ rate: 'five hundred' }))).toContainEqual({ path: 'rate', message: 'Rate is required' });
    });

    /**
     * Regression guard, same shape as Item Master's GST rate: plain `z.coerce.number()` turns
     * '', null and [] into 0 — and 0 is a legitimate rate — so a blank field would silently be
     * saved as free of charge.
     */
    it.each(['', null, []])('rejects a blank rate (%p) instead of silently saving it as 0', (blank) => {
      expect(issuesFor(makeSubItem({ rate: blank }))).toContainEqual({ path: 'rate', message: 'Rate is required' });
    });

    it('rejects a third decimal rather than rounding the price behind the user', () => {
      expect(issuesFor(makeSubItem({ rate: 500.555 }))).toContainEqual({ path: 'rate', message: 'Rate can have at most 2 decimal places' });
    });

    it('accepts the largest value the numeric(12, 2) column can hold', () => {
      expect(parseSubItem(makeSubItem({ rate: SUB_ITEM_RATE_MAX }))).toMatchObject({ rate: SUB_ITEM_RATE_MAX });
    });

    it('rejects a value past the column ceiling as validation, not as a database error', () => {
      expect(issuesFor(makeSubItem({ rate: 10_000_000_000 }))).toContainEqual({ path: 'rate', message: 'Rate is too large' });
    });
  });

  describe('remark', () => {
    it('is optional and becomes null when omitted', () => {
      expect(parseSubItem(makeSubItem())).toMatchObject({ remark: null });
    });

    it.each(['', '   '])('stores a blank remark (%p) as null, never as an empty string', (blank) => {
      expect(parseSubItem(makeSubItem({ remark: blank }))).toMatchObject({ remark: null });
    });

    it('trims a remark that is present', () => {
      expect(parseSubItem(makeSubItem({ remark: '  Premium finish  ' }))).toMatchObject({ remark: 'Premium finish' });
    });

    it('rejects a remark longer than 500 characters', () => {
      expect(issuesFor(makeSubItem({ remark: 'a'.repeat(501) }))).toContainEqual({
        path: 'remark',
        message: 'Remark cannot exceed 500 characters',
      });
    });
  });
});

/**
 * PUT goes through `subItemSchema.partial()` (see lib/crud.ts). Absent fields must stay
 * absent — an update that silently re-applied `isActive: true` would reactivate every product
 * the user edits, and one that re-applied a default parent would re-home it.
 */
describe('subItemSchema.partial() (update payload)', () => {
  const partial = subItemSchema.partial();

  it('accepts an empty patch', () => {
    expect(parseSubItem({}, partial)).toEqual({});
  });

  it('does not re-apply the isActive default, so editing an inactive product leaves it inactive', () => {
    expect(parseSubItem({ productName: 'Album Design' }, partial)).toEqual({ productName: 'Album Design' });
  });

  it('leaves the parent item alone when the patch does not mention it', () => {
    expect(parseSubItem({ rate: 750 }, partial)).toEqual({ rate: 750 });
  });

  it('does not turn an untouched remark into null', () => {
    expect(parseSubItem({ rate: 750 }, partial)).not.toHaveProperty('remark');
  });

  it('clears a remark that is explicitly blanked out', () => {
    expect(parseSubItem({ remark: '' }, partial)).toEqual({ remark: null });
  });

  it('still rejects a blanked-out product name', () => {
    expect(issuesFor({ productName: '   ' }, partial)).toContainEqual({ path: 'productName', message: 'Product name is required' });
  });

  it('still rejects a negative rate', () => {
    expect(issuesFor({ rate: -0.01 }, partial)).toContainEqual({ path: 'rate', message: 'Rate cannot be negative' });
  });

  it.each(['', null, []])('still rejects a blanked-out rate (%p)', (blank) => {
    expect(issuesFor({ rate: blank }, partial)).toContainEqual({ path: 'rate', message: 'Rate is required' });
  });

  it('still rejects an item id that is not a uuid', () => {
    expect(issuesFor({ itemId: 'Photography' }, partial)).toContainEqual({ path: 'itemId', message: 'Select a valid item' });
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * The relationship to Item Master, tenant isolation, permission enforcement and the
 * per-item duplicate guard can only be proved against a real database, so this suite is
 * SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users, items
 * and sub items, and must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Sub Item Master API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let eq: typeof import('drizzle-orm').eq;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  let tokenA = '';
  let tokenAReadOnly = '';
  let tokenB = '';
  /** Tenant A's items: "Photography" and "Passport Photo" — the two parents most tests hang off. */
  let photographyId = '';
  let passportId = '';
  let inactiveItemId = '';
  let tenantBItemId = '';
  let tenantBSubItemId = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/masters/sub-items', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/masters/sub-items/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/masters/sub-items/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/masters/sub-items${path}`, headers: auth(token) });

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

  /** Item Master rows are set up directly — Item Master has its own suite. */
  async function seedItem(tenantId: string, itemName: string, isActive = true) {
    const [item] = await db.insert(schema.items).values({ tenantId, itemName, hsnCode: '998383', gstRate: '18.00', isActive }).returning();
    return item.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0'; // server.ts boots a listener on import; keep it off a real port
    const orm = await import('drizzle-orm');
    eq = orm.eq;
    inArray = orm.inArray;
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const full = { masters_sub_items: ['read', 'create', 'update', 'delete'], masters_items: ['read', 'create', 'update', 'delete'] };
    const a = await seedTenant('sub-tenant-a', full);
    tokenA = a.token;
    ({ token: tokenAReadOnly } = await seedTenant('sub-tenant-a-readonly', { masters_sub_items: ['read'] }));
    const b = await seedTenant('sub-tenant-b', full);
    tokenB = b.token;

    photographyId = await seedItem(a.tenantId, 'Photography');
    passportId = await seedItem(a.tenantId, 'Passport Photo');
    inactiveItemId = await seedItem(a.tenantId, 'Retired Service', false);
    tenantBItemId = await seedItem(b.tenantId, 'Tenant B Photography');
    tenantBSubItemId = (await post(tokenB, { itemId: tenantBItemId, productName: 'Tenant B Shoot', rate: 999 })).json().data.id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      // sub items first: the composite foreign key to items is RESTRICT on purpose
      await db.delete(schema.subItems).where(inArray(schema.subItems.tenantId, tenantIds));
      await db.delete(schema.items).where(inArray(schema.items.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('create', () => {
    it('creates a sub item under its parent item', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'Pre-Wedding', rate: 3500, remark: 'Outdoor' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ itemId: photographyId, productName: 'Pre-Wedding', rate: 3500, remark: 'Outdoor', isActive: true });
    });

    it('rejects a payload with no rate', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'No Rate' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a negative rate', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'Negative', rate: -10 });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an item id that does not exist', async () => {
      const res = await post(tokenA, { itemId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', productName: 'Orphan', rate: 100 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Select a valid item');
    });

    it('allows a sub item under an item that has since been deactivated, without corrupting the link', async () => {
      const res = await post(tokenA, { itemId: inactiveItemId, productName: 'Legacy Product', rate: 100 });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.itemId).toBe(inactiveItemId);
    });
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/masters/sub-items' });
      expect(res.statusCode).toBe(401);
    });

    it('refuses to create for a role granted only read on masters_sub_items', async () => {
      const res = await post(tokenAReadOnly, { itemId: photographyId, productName: 'Should Not Exist', rate: 100 });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('create permission for masters_sub_items');
    });

    it('refuses to update for a role granted only read', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Guarded Update', rate: 100 });
      const res = await put(tokenAReadOnly, created.json().data.id, { rate: 200 });
      expect(res.statusCode).toBe(403);
    });

    it('refuses to delete for a role granted only read', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Guarded Delete', rate: 100 });
      const res = await del(tokenAReadOnly, created.json().data.id);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another tenant's sub item by id", async () => {
      expect((await get(tokenA, `/${tenantBSubItemId}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's sub item", async () => {
      expect((await put(tokenA, tenantBSubItemId, { rate: 1 })).statusCode).toBe(404);
    });

    it("cannot delete another tenant's sub item", async () => {
      expect((await del(tokenA, tenantBSubItemId)).statusCode).toBe(404);
    });

    it("never lists another tenant's sub items", async () => {
      const rows = (await get(tokenA)).json().data.rows as { id: string }[];
      expect(rows.some((r) => r.id === tenantBSubItemId)).toBe(false);
    });

    /** The composite foreign key makes this structurally impossible; the check makes it a 400. */
    it("refuses to attach a sub item to another tenant's item", async () => {
      const res = await post(tokenA, { itemId: tenantBItemId, productName: 'Hijack', rate: 100 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Select a valid item');
    });

    it("refuses to re-point an existing sub item at another tenant's item", async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Repoint Target', rate: 100 });
      const res = await put(tokenA, created.json().data.id, { itemId: tenantBItemId });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('duplicate product names', () => {
    it('refuses a second product with the same name under the same item', async () => {
      await post(tokenA, { itemId: photographyId, productName: 'Wedding Shoot', rate: 2500 });
      const res = await post(tokenA, { itemId: photographyId, productName: 'Wedding Shoot', rate: 2500 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('"Wedding Shoot" already exists under this item');
    });

    it('treats product names case-insensitively within an item', async () => {
      await post(tokenA, { itemId: photographyId, productName: 'Drone Coverage', rate: 5000 });
      expect((await post(tokenA, { itemId: photographyId, productName: 'DRONE COVERAGE', rate: 5000 })).statusCode).toBe(400);
    });

    /** The same product name under a different item is the point of the module, not a clash. */
    it('allows the same product name under a different item', async () => {
      await post(tokenA, { itemId: photographyId, productName: '8 Copy', rate: 500 });
      expect((await post(tokenA, { itemId: passportId, productName: '8 Copy', rate: 100 })).statusCode).toBe(200);
    });

    it('allows the same product name under the same item name in a different tenant', async () => {
      expect((await post(tokenB, { itemId: tenantBItemId, productName: 'Wedding Shoot', rate: 2500 })).statusCode).toBe(200);
    });

    it('lets a sub item keep its own name when it is updated', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Reel Editing', rate: 1000 });
      const res = await put(tokenA, created.json().data.id, { productName: 'Reel Editing', rate: 1200 });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.rate).toBe(1200);
    });

    it("refuses to rename a product onto a sibling's name", async () => {
      await post(tokenA, { itemId: passportId, productName: '16 Copy', rate: 130 });
      const other = await post(tokenA, { itemId: passportId, productName: '32 Copy', rate: 200 });
      expect((await put(tokenA, other.json().data.id, { productName: '16 copy' })).statusCode).toBe(400);
    });

    /** Moving a product to an item that already has that name has to clash on the new parent. */
    it('refuses to move a product onto an item that already has that product', async () => {
      await post(tokenA, { itemId: passportId, productName: 'Moved Product', rate: 100 });
      const created = await post(tokenA, { itemId: photographyId, productName: 'Moved Product', rate: 100 });
      expect((await put(tokenA, created.json().data.id, { itemId: passportId })).statusCode).toBe(400);
    });
  });

  describe('update', () => {
    it('updates rate and remark without touching the parent item', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Editable', rate: 100, remark: 'first' });
      const res = await put(tokenA, created.json().data.id, { rate: 250.75, remark: 'second' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ itemId: photographyId, rate: 250.75, remark: 'second' });
    });

    it('clears a remark that is blanked out', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Clearable Remark', rate: 100, remark: 'temporary' });
      expect((await put(tokenA, created.json().data.id, { remark: '' })).json().data.remark).toBeNull();
    });

    it('leaves isActive untouched when an update does not mention it', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Stays Inactive', rate: 100, isActive: false });
      expect((await put(tokenA, created.json().data.id, { rate: 150 })).json().data.isActive).toBe(false);
    });

    /** A record whose parent was retired must still be editable, and must keep that parent. */
    it('keeps an inactive parent when the record is edited', async () => {
      const created = await post(tokenA, { itemId: inactiveItemId, productName: 'Edited Legacy', rate: 100 });
      const res = await put(tokenA, created.json().data.id, { rate: 120 });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.itemId).toBe(inactiveItemId);
    });
  });

  describe('list', () => {
    it('carries the parent item name on every row, without a query per row', async () => {
      await post(tokenA, { itemId: photographyId, productName: 'Named Parent Check', rate: 100 });
      const rows = (await get(tokenA, '?search=Named Parent Check')).json().data.rows as { itemName: string }[];
      expect(rows[0].itemName).toBe('Photography');
    });

    it('searches by parent item name as well as product name', async () => {
      await post(tokenA, { itemId: passportId, productName: 'Searchable By Parent', rate: 100 });
      const rows = (await get(tokenA, '?search=Passport')).json().data.rows as { productName: string }[];
      expect(rows.some((r) => r.productName === 'Searchable By Parent')).toBe(true);
    });

    it('filters to a single parent item', async () => {
      const res = await get(tokenA, `?itemId=${passportId}&limit=100`);
      const rows = res.json().data.rows as { itemId: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.itemId === passportId)).toBe(true);
    });

    it('filters by status', async () => {
      await post(tokenA, { itemId: photographyId, productName: 'Inactive For Filter', rate: 100, isActive: false });
      const rows = (await get(tokenA, '?isActive=false&limit=100')).json().data.rows as { isActive: boolean }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.isActive === false)).toBe(true);
    });

    it('reports a total that matches the filter, not the whole table', async () => {
      const res = await get(tokenA, `?itemId=${passportId}&limit=1`);
      const { rows, total } = res.json().data as { rows: unknown[]; total: number };
      const all = (await get(tokenA, `?itemId=${passportId}&limit=100`)).json().data.rows as unknown[];
      expect(rows).toHaveLength(1);
      expect(total).toBe(all.length);
    });
  });

  describe('stored values', () => {
    it('stores the rate at 2-decimal scale and returns it as a number', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'Scale Check', rate: '1250.5' });
      expect(res.json().data.rate).toBe(1250.5);
      const [row] = await db.select().from(schema.subItems).where(eq(schema.subItems.id, res.json().data.id));
      expect(row.rate).toBe('1250.50');
    });

    it('round-trips a rate with paise intact', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Paise Check', rate: 1999.99 });
      expect((await get(tokenA, `/${created.json().data.id}`)).json().data.rate).toBe(1999.99);
    });

    it('stores a zero rate as zero, not as null', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'Free Product', rate: 0 });
      expect(res.json().data.rate).toBe(0);
    });

    it('stores an omitted remark as null', async () => {
      const res = await post(tokenA, { itemId: photographyId, productName: 'No Remark', rate: 100 });
      expect(res.json().data.remark).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes a sub item', async () => {
      const created = await post(tokenA, { itemId: photographyId, productName: 'Deletable', rate: 100 });
      expect((await del(tokenA, created.json().data.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${created.json().data.id}`)).statusCode).toBe(404);
    });

    /**
     * Item Master is protected by the RESTRICT foreign key: an item that still has products
     * cannot be deleted out from under them. Billing will lean on the same rule for sub items.
     */
    it('refuses to delete an item that still has sub items, and says what is in the way', async () => {
      const guardedItemId = await seedItem(tenantIds[0], `Guarded Item ${Date.now()}`);
      await post(tokenA, { itemId: guardedItemId, productName: 'Blocks Parent Delete', rate: 100 });
      const res = await app.inject({ method: 'DELETE', url: `/api/masters/items/${guardedItemId}`, headers: auth(tokenA) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('still has 1 sub item');
    });

    /** ...and the RESTRICT foreign key holds even if something bypasses the route. */
    it('lets the database refuse the same delete on its own', async () => {
      const guardedItemId = await seedItem(tenantIds[0], `Guarded Item Raw ${Date.now()}`);
      await post(tokenA, { itemId: guardedItemId, productName: 'Blocks Raw Delete', rate: 100 });
      await expect(db.delete(schema.items).where(eq(schema.items.id, guardedItemId))).rejects.toThrow();
    });
  });
});
