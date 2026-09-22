import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { GST_RATES, itemSchema } from '@erp/shared';

/**
 * Item Master.
 *
 * Section A is pure validation — no database, always runs. It is where the real rules live:
 * the shared zod schema is the only thing standing between a client and the items table.
 * Section B needs a database and is skipped unless TEST_DATABASE_URL is set (see below).
 */

/* --------------------------------------------------------------- helpers -- */

/** Minimal valid Item Master payload; override only what the test is about. */
const makeItem = (overrides: Record<string, unknown> = {}) => ({
  itemName: 'Wedding Photography',
  hsnCode: '998383',
  gstRate: 18,
  ...overrides,
});

/** Parse and fail loudly if the input was supposed to be valid. */
const parseItem = (input: unknown, schema: ZodTypeAny = itemSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = itemSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('itemSchema (create payload)', () => {
  it('accepts a valid item and trims the item name and HSN code', () => {
    expect(parseItem(makeItem({ itemName: '  Wedding Photography  ', hsnCode: ' 998383 ' }))).toEqual({
      itemName: 'Wedding Photography',
      hsnCode: '998383',
      gstRate: 18,
      isActive: true,
    });
  });

  it('defaults a new item to active when isActive is omitted', () => {
    expect(parseItem(makeItem())).toMatchObject({ isActive: true });
  });

  it('keeps an explicit isActive:false', () => {
    expect(parseItem(makeItem({ isActive: false }))).toMatchObject({ isActive: false });
  });

  describe('itemName', () => {
    it('is required', () => {
      const body = makeItem();
      delete (body as Record<string, unknown>).itemName;
      expect(issuesFor(body)).toContainEqual({ path: 'itemName', message: 'Required' });
    });

    it('rejects an empty name', () => {
      expect(issuesFor(makeItem({ itemName: '' }))).toContainEqual({ path: 'itemName', message: 'Item name is required' });
    });

    it('rejects a whitespace-only name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeItem({ itemName: '   ' }))).toContainEqual({ path: 'itemName', message: 'Item name is required' });
    });

    it('accepts a name of exactly 120 characters', () => {
      expect(parseItem(makeItem({ itemName: 'a'.repeat(120) }))).toMatchObject({ itemName: 'a'.repeat(120) });
    });

    it('rejects a name longer than 120 characters', () => {
      expect(issuesFor(makeItem({ itemName: 'a'.repeat(121) }))).toContainEqual({
        path: 'itemName',
        message: 'Item name cannot exceed 120 characters',
      });
    });

    it('measures the length after trimming, so surrounding spaces do not push a 120-character name over the limit', () => {
      expect(parseItem(makeItem({ itemName: `  ${'a'.repeat(120)}  ` }))).toMatchObject({ itemName: 'a'.repeat(120) });
    });
  });

  describe('hsnCode', () => {
    it('is required', () => {
      const body = makeItem();
      delete (body as Record<string, unknown>).hsnCode;
      expect(issuesFor(body)).toContainEqual({ path: 'hsnCode', message: 'Required' });
    });

    it('rejects an empty HSN code', () => {
      expect(issuesFor(makeItem({ hsnCode: '' }))).toContainEqual({ path: 'hsnCode', message: 'HSN code is required' });
    });

    it('rejects a whitespace-only HSN code', () => {
      expect(issuesFor(makeItem({ hsnCode: '  ' }))).toContainEqual({ path: 'hsnCode', message: 'HSN code is required' });
    });

    it('keeps leading zeros exactly as typed — an HSN code is an identifier, never a number', () => {
      const parsed = parseItem(makeItem({ hsnCode: '00440' })) as { hsnCode: string };
      expect(parsed.hsnCode).toBe('00440');
      expect(typeof parsed.hsnCode).toBe('string');
    });

    it('keeps leading zeros after trimming', () => {
      expect(parseItem(makeItem({ hsnCode: '  00440  ' }))).toMatchObject({ hsnCode: '00440' });
    });

    it('rejects an HSN code longer than 20 characters', () => {
      expect(issuesFor(makeItem({ hsnCode: '0'.repeat(21) }))).toContainEqual({
        path: 'hsnCode',
        message: 'HSN code cannot exceed 20 characters',
      });
    });
  });

  describe('gstRate', () => {
    it.each([...GST_RATES])('accepts the statutory %i%% slab', (rate) => {
      expect(parseItem(makeItem({ gstRate: rate }))).toMatchObject({ gstRate: rate });
    });

    it.each([7, 15, 3, 100, -5])('rejects %i%%, which is not a statutory slab', (rate) => {
      expect(issuesFor(makeItem({ gstRate: rate }))).toContainEqual({
        path: 'gstRate',
        message: 'GST % must be one of 0%, 5%, 12%, 18%, 28%',
      });
    });

    it('names the allowed slabs in the error so the form can show them', () => {
      const [issue] = issuesFor(makeItem({ gstRate: 7 }));
      expect(issue.message).toBe(`GST % must be one of ${GST_RATES.map((r) => `${r}%`).join(', ')}`);
    });

    it('accepts a numeric string from a form and coerces it to a number', () => {
      const parsed = parseItem(makeItem({ gstRate: '18' })) as { gstRate: number };
      expect(parsed.gstRate).toBe(18);
      expect(typeof parsed.gstRate).toBe('number');
    });

    it('is required', () => {
      const body = makeItem();
      delete (body as Record<string, unknown>).gstRate;
      expect(issuesFor(body)).toContainEqual({ path: 'gstRate', message: 'GST % is required' });
    });

    it('rejects non-numeric text', () => {
      expect(issuesFor(makeItem({ gstRate: 'eighteen' }))).toContainEqual({ path: 'gstRate', message: 'GST % is required' });
    });

    /**
     * Regression: plain `z.coerce.number()` turns '', null and [] into 0 — itself a valid
     * slab — so a payload with no GST rate was silently stored as 0% (exempt). 0% must be an
     * explicit choice, never the by-product of an empty field. Guarded by z.preprocess.
     */
    it.each(['', null, []])('rejects a blank GST rate (%p) instead of silently saving it as 0%%', (blank) => {
      expect(issuesFor(makeItem({ gstRate: blank }))).toContainEqual({ path: 'gstRate', message: 'GST % is required' });
    });
  });
});

/**
 * PUT goes through `itemSchema.partial()` (see lib/crud.ts). The rules must still hold for
 * the fields that are present, and absent fields must stay absent — an update that silently
 * re-applied `isActive: true` would reactivate every item the user edits.
 */
describe('itemSchema.partial() (update payload)', () => {
  const partial = itemSchema.partial();

  it('accepts an empty patch', () => {
    expect(parseItem({}, partial)).toEqual({});
  });

  it('does not re-apply the isActive default, so editing an inactive item leaves it inactive', () => {
    expect(parseItem({ itemName: 'Candid Photography' }, partial)).toEqual({ itemName: 'Candid Photography' });
  });

  it('still trims the fields that are present', () => {
    expect(parseItem({ itemName: '  Album Printing  ', hsnCode: ' 00440 ' }, partial)).toEqual({
      itemName: 'Album Printing',
      hsnCode: '00440',
    });
  });

  it('still rejects a blanked-out item name', () => {
    expect(issuesFor({ itemName: '   ' }, partial)).toContainEqual({ path: 'itemName', message: 'Item name is required' });
  });

  it('still rejects a blanked-out HSN code', () => {
    expect(issuesFor({ hsnCode: '' }, partial)).toContainEqual({ path: 'hsnCode', message: 'HSN code is required' });
  });

  it('still rejects a name longer than 120 characters', () => {
    expect(issuesFor({ itemName: 'a'.repeat(121) }, partial)).toContainEqual({
      path: 'itemName',
      message: 'Item name cannot exceed 120 characters',
    });
  });

  it('still rejects a non-statutory GST slab', () => {
    expect(issuesFor({ gstRate: 15 }, partial)).toContainEqual({
      path: 'gstRate',
      message: 'GST % must be one of 0%, 5%, 12%, 18%, 28%',
    });
  });

  it('still coerces a numeric string slab', () => {
    expect(parseItem({ gstRate: '5' }, partial)).toEqual({ gstRate: 5 });
  });

  // The blank-GST guard has to hold on the update path too: a PUT carrying an emptied GST
  // field must be refused, not silently re-rate an 18% item to 0%.
  it.each(['', null, []])('still rejects a blanked-out GST rate (%p)', (blank) => {
    expect(issuesFor({ gstRate: blank }, partial)).toContainEqual({ path: 'gstRate', message: 'GST % is required' });
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Tenant isolation, permission enforcement and the duplicate-name guard can only be proved
 * against a real database, so this suite is SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles and users, and
 * must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 *
 * Everything db-touching is imported dynamically so DATABASE_URL can be overridden first
 * (dotenv does not overwrite a variable that is already set).
 */
describe.skipIf(!TEST_DB)('Item Master API (integration, needs TEST_DATABASE_URL)', () => {
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
  let tenantBItemId = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/masters/items', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/masters/items/${id}`, headers: auth(token), payload: payload as object });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/masters/items${path}`, headers: auth(token) });

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
    const orm = await import('drizzle-orm');
    eq = orm.eq;
    inArray = orm.inArray;
    const client = await import('../db/client');
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const full = { masters_items: ['read', 'create', 'update', 'delete'] };
    ({ token: tokenA } = await seedTenant('tenant-a', full));
    ({ token: tokenAReadOnly } = await seedTenant('tenant-a-readonly', { masters_items: ['read'] }));
    ({ token: tokenB } = await seedTenant('tenant-b', full));

    const created = await post(tokenB, { itemName: 'Tenant B Album', hsnCode: '998386', gstRate: 12 });
    tenantBItemId = created.json().data.id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(schema.items).where(inArray(schema.items.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/masters/items' });
      expect(res.statusCode).toBe(401);
    });

    it('refuses to create an item for a role granted only read on masters_items', async () => {
      const res = await post(tokenAReadOnly, { itemName: 'Should Not Exist', hsnCode: '998383', gstRate: 18 });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('create permission for masters_items');
    });

    it('refuses to delete an item for a role granted only read on masters_items', async () => {
      const created = await post(tokenA, { itemName: 'Deletable Item', hsnCode: '998383', gstRate: 18 });
      const res = await app.inject({ method: 'DELETE', url: `/api/masters/items/${created.json().data.id}`, headers: auth(tokenAReadOnly) });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another tenant's item by id", async () => {
      const res = await get(tokenA, `/${tenantBItemId}`);
      expect(res.statusCode).toBe(404);
    });

    it("cannot update another tenant's item", async () => {
      const res = await put(tokenA, tenantBItemId, { itemName: 'Hijacked' });
      expect(res.statusCode).toBe(404);
    });

    it("cannot delete another tenant's item", async () => {
      const res = await app.inject({ method: 'DELETE', url: `/api/masters/items/${tenantBItemId}`, headers: auth(tokenA) });
      expect(res.statusCode).toBe(404);
    });

    it("never lists another tenant's items", async () => {
      await post(tokenA, { itemName: 'Tenant A Album', hsnCode: '998386', gstRate: 12 });
      const rows = get(tokenA).then((r) => r.json().data.rows as { id: string }[]);
      expect((await rows).some((r) => r.id === tenantBItemId)).toBe(false);
    });
  });

  describe('duplicate item names', () => {
    it('refuses a second item with the same name in the same tenant', async () => {
      await post(tokenA, { itemName: 'Candid Photography', hsnCode: '998383', gstRate: 18 });
      const res = await post(tokenA, { itemName: 'Candid Photography', hsnCode: '998383', gstRate: 18 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('An item named "Candid Photography" already exists');
    });

    it('treats item names case-insensitively', async () => {
      await post(tokenA, { itemName: 'Drone Coverage', hsnCode: '998383', gstRate: 18 });
      const res = await post(tokenA, { itemName: 'DRONE COVERAGE', hsnCode: '998383', gstRate: 18 });
      expect(res.statusCode).toBe(400);
    });

    it('allows the same item name in a different tenant', async () => {
      await post(tokenA, { itemName: 'Shared Name', hsnCode: '998383', gstRate: 18 });
      const res = await post(tokenB, { itemName: 'Shared Name', hsnCode: '998383', gstRate: 18 });
      expect(res.statusCode).toBe(200);
    });

    it('lets an item keep its own name when it is updated', async () => {
      const created = await post(tokenA, { itemName: 'Reel Editing', hsnCode: '998383', gstRate: 18 });
      const res = await put(tokenA, created.json().data.id, { itemName: 'Reel Editing', gstRate: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.gstRate).toBe(5);
    });

    it("refuses to rename an item onto another item's name", async () => {
      await post(tokenA, { itemName: 'Photo Frame', hsnCode: '998383', gstRate: 18 });
      const other = await post(tokenA, { itemName: 'Photo Book', hsnCode: '998383', gstRate: 18 });
      const res = await put(tokenA, other.json().data.id, { itemName: 'photo frame' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('stored values', () => {
    it('stores the GST rate at 2-decimal scale and returns it as a number', async () => {
      const res = await post(tokenA, { itemName: 'Scale Check', hsnCode: '998383', gstRate: '18' });
      expect(res.json().data.gstRate).toBe(18);
      const [row] = await db.select().from(schema.items).where(eq(schema.items.id, res.json().data.id));
      expect(row.gstRate).toBe('18.00');
    });

    it('stores an HSN code with leading zeros unchanged', async () => {
      const res = await post(tokenA, { itemName: 'Leading Zero HSN', hsnCode: '00440', gstRate: 0 });
      expect(res.json().data.hsnCode).toBe('00440');
      const reread = await get(tokenA, `/${res.json().data.id}`);
      expect(reread.json().data.hsnCode).toBe('00440');
    });

    it('leaves isActive untouched when an update does not mention it', async () => {
      const created = await post(tokenA, { itemName: 'Inactive Item', hsnCode: '998383', gstRate: 18, isActive: false });
      const res = await put(tokenA, created.json().data.id, { hsnCode: '998385' });
      expect(res.json().data.isActive).toBe(false);
    });
  });
});
