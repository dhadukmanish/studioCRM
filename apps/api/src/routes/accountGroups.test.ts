import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { HEAD_GROUPS, accountGroupSchema } from '@erp/shared';

/**
 * Account Group Master.
 *
 * Section A is pure validation — no database, always runs. Section B needs a database and is
 * skipped unless TEST_DATABASE_URL is set; it is where the duplicate guard, the head-group
 * and status filters, tenant isolation and permission enforcement live.
 */

/* --------------------------------------------------------------- helpers -- */

/** Minimal valid Account Group payload; override only what the test is about. */
const makeGroup = (overrides: Record<string, unknown> = {}) => ({
  groupName: 'CUSTOMER',
  headGroup: 'ASSETS',
  ...overrides,
});

const parseGroup = (input: unknown, schema: ZodTypeAny = accountGroupSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = accountGroupSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('accountGroupSchema (create payload)', () => {
  it('accepts a valid group and trims the name', () => {
    expect(parseGroup(makeGroup({ groupName: '  CUSTOMER  ' }))).toEqual({ groupName: 'CUSTOMER', headGroup: 'ASSETS', isActive: true });
  });

  it('defaults a new group to active when isActive is omitted', () => {
    expect(parseGroup(makeGroup())).toMatchObject({ isActive: true });
  });

  it('keeps an explicit isActive:false', () => {
    expect(parseGroup(makeGroup({ isActive: false }))).toMatchObject({ isActive: false });
  });

  describe('groupName', () => {
    it('is required', () => {
      const body = makeGroup();
      delete (body as Record<string, unknown>).groupName;
      expect(issuesFor(body)).toContainEqual({ path: 'groupName', message: 'Required' });
    });

    it('rejects an empty name', () => {
      expect(issuesFor(makeGroup({ groupName: '' }))).toContainEqual({ path: 'groupName', message: 'Account group name is required' });
    });

    it('rejects a whitespace-only name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeGroup({ groupName: '   ' }))).toContainEqual({ path: 'groupName', message: 'Account group name is required' });
    });

    it('accepts a name of exactly 120 characters', () => {
      expect(parseGroup(makeGroup({ groupName: 'a'.repeat(120) }))).toMatchObject({ groupName: 'a'.repeat(120) });
    });

    it('rejects a name longer than 120 characters', () => {
      expect(issuesFor(makeGroup({ groupName: 'a'.repeat(121) }))).toContainEqual({
        path: 'groupName',
        message: 'Account group name cannot exceed 120 characters',
      });
    });

    it('keeps a name with a slash, as the legacy data uses ("EXPOSER/PARTY")', () => {
      expect(parseGroup(makeGroup({ groupName: 'EXPOSER/PARTY' }))).toMatchObject({ groupName: 'EXPOSER/PARTY' });
    });
  });

  describe('headGroup', () => {
    it.each([...HEAD_GROUPS])('accepts the %s head group', (head) => {
      expect(parseGroup(makeGroup({ headGroup: head }))).toMatchObject({ headGroup: head });
    });

    it('is required', () => {
      const body = makeGroup();
      delete (body as Record<string, unknown>).headGroup;
      expect(issuesFor(body)).toContainEqual({ path: 'headGroup', message: 'Type is required' });
    });

    /** An unselected dropdown posts '' — a missing answer, not a wrong one. */
    it('reports an unselected dropdown as required, not as an invalid value', () => {
      expect(issuesFor(makeGroup({ headGroup: '' }))).toContainEqual({ path: 'headGroup', message: 'Type is required' });
    });

    it.each(['CAPITAL', 'assets', 'Bank', 'REVENUE'])('rejects %p, which is not a supported head group', (head) => {
      expect(issuesFor(makeGroup({ headGroup: head }))).toContainEqual({
        path: 'headGroup',
        message: `Type must be one of ${HEAD_GROUPS.join(', ')}`,
      });
    });

    /**
     * Guards the business reference: the supported set is exactly what the studio's existing
     * accounting uses. Adding a category silently would misclassify every account under it.
     */
    it('supports exactly the six documented head groups', () => {
      expect([...HEAD_GROUPS]).toEqual(['LIABILITIES', 'ASSETS', 'EXPENSES', 'INCOME', 'CASH', 'OTHER']);
    });
  });
});

/**
 * PUT goes through `accountGroupSchema.partial()` (see lib/crud.ts). Absent fields must stay
 * absent — an update that silently re-applied `isActive: true` would reactivate every group
 * the user edits.
 */
describe('accountGroupSchema.partial() (update payload)', () => {
  const partial = accountGroupSchema.partial();

  it('accepts an empty patch', () => {
    expect(parseGroup({}, partial)).toEqual({});
  });

  it('does not re-apply the isActive default, so editing an inactive group leaves it inactive', () => {
    expect(parseGroup({ groupName: 'BANK' }, partial)).toEqual({ groupName: 'BANK' });
  });

  it('leaves the head group alone when the patch does not mention it', () => {
    expect(parseGroup({ groupName: 'BANK' }, partial)).not.toHaveProperty('headGroup');
  });

  it('still trims a name that is present', () => {
    expect(parseGroup({ groupName: '  LOAN  ' }, partial)).toEqual({ groupName: 'LOAN' });
  });

  it('still rejects a blanked-out name', () => {
    expect(issuesFor({ groupName: '   ' }, partial)).toContainEqual({ path: 'groupName', message: 'Account group name is required' });
  });

  it('still rejects an unsupported head group', () => {
    expect(issuesFor({ headGroup: 'CAPITAL' }, partial)).toContainEqual({
      path: 'headGroup',
      message: `Type must be one of ${HEAD_GROUPS.join(', ')}`,
    });
  });

  it('still rejects a blanked-out head group', () => {
    expect(issuesFor({ headGroup: '' }, partial)).toContainEqual({ path: 'headGroup', message: 'Type is required' });
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Tenant isolation, permission enforcement, the duplicate-name guard and the list filters can
 * only be proved against a real database, so this suite is SKIPPED unless TEST_DATABASE_URL
 * is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users and
 * account groups, and must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Account Group Master API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  let tokenA = '';
  let tokenAReadOnly = '';
  let tokenB = '';
  let tenantBGroupId = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/masters/account-groups', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/masters/account-groups/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/masters/account-groups/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/masters/account-groups${path}`, headers: auth(token) });

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
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const full = { masters_account_groups: ['read', 'create', 'update', 'delete'] };
    ({ token: tokenA } = await seedTenant('ag-tenant-a', full));
    ({ token: tokenAReadOnly } = await seedTenant('ag-tenant-a-readonly', { masters_account_groups: ['read'] }));
    ({ token: tokenB } = await seedTenant('ag-tenant-b', full));

    tenantBGroupId = (await post(tokenB, { groupName: 'TENANT B BANK', headGroup: 'ASSETS' })).json().data.id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(schema.accountGroups).where(inArray(schema.accountGroups.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('create', () => {
    it('creates an account group under its head group', async () => {
      const res = await post(tokenA, { groupName: 'CASH', headGroup: 'CASH' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ groupName: 'CASH', headGroup: 'CASH', isActive: true });
    });

    it('rejects a payload with no name', async () => {
      expect((await post(tokenA, { headGroup: 'ASSETS' })).statusCode).toBe(400);
    });

    it('rejects a payload with no head group', async () => {
      expect((await post(tokenA, { groupName: 'NO TYPE' })).statusCode).toBe(400);
    });

    it('rejects an unsupported head group', async () => {
      const res = await post(tokenA, { groupName: 'CAPITAL ACCOUNT', headGroup: 'CAPITAL' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/masters/account-groups' })).statusCode).toBe(401);
    });

    it('refuses to create for a role granted only read on masters_account_groups', async () => {
      const res = await post(tokenAReadOnly, { groupName: 'SHOULD NOT EXIST', headGroup: 'OTHER' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('create permission for masters_account_groups');
    });

    it('refuses to update for a role granted only read', async () => {
      const created = await post(tokenA, { groupName: 'GUARDED UPDATE', headGroup: 'OTHER' });
      expect((await put(tokenAReadOnly, created.json().data.id, { headGroup: 'CASH' })).statusCode).toBe(403);
    });

    it('refuses to delete for a role granted only read', async () => {
      const created = await post(tokenA, { groupName: 'GUARDED DELETE', headGroup: 'OTHER' });
      expect((await del(tokenAReadOnly, created.json().data.id)).statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another tenant's group by id", async () => {
      expect((await get(tokenA, `/${tenantBGroupId}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's group", async () => {
      expect((await put(tokenA, tenantBGroupId, { groupName: 'HIJACKED' })).statusCode).toBe(404);
    });

    it("cannot delete another tenant's group", async () => {
      expect((await del(tokenA, tenantBGroupId)).statusCode).toBe(404);
    });

    it("never lists another tenant's groups", async () => {
      const rows = (await get(tokenA, '?limit=100')).json().data.rows as { id: string }[];
      expect(rows.some((r) => r.id === tenantBGroupId)).toBe(false);
    });

    it('keeps the lookup tenant-scoped too', async () => {
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/account-groups', headers: auth(tokenA) })).json().data as { id: string }[];
      expect(rows.some((r) => r.id === tenantBGroupId)).toBe(false);
    });
  });

  describe('duplicate group names', () => {
    it('refuses a second group with the same name in the same tenant', async () => {
      await post(tokenA, { groupName: 'BANK', headGroup: 'ASSETS' });
      const res = await post(tokenA, { groupName: 'BANK', headGroup: 'ASSETS' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('An account group named "BANK" already exists');
    });

    /** Duplicate regardless of head group: the name is the business key, not the pair. */
    it('refuses a duplicate name even under a different head group', async () => {
      await post(tokenA, { groupName: 'EMPLOYEE', headGroup: 'LIABILITIES' });
      expect((await post(tokenA, { groupName: 'EMPLOYEE', headGroup: 'EXPENSES' })).statusCode).toBe(400);
    });

    it('treats group names case-insensitively', async () => {
      await post(tokenA, { groupName: 'PARTNER', headGroup: 'ASSETS' });
      expect((await post(tokenA, { groupName: 'partner', headGroup: 'ASSETS' })).statusCode).toBe(400);
    });

    it('allows the same group name in a different tenant', async () => {
      await post(tokenA, { groupName: 'SHARED NAME', headGroup: 'OTHER' });
      expect((await post(tokenB, { groupName: 'SHARED NAME', headGroup: 'OTHER' })).statusCode).toBe(200);
    });

    it('lets a group keep its own name when it is updated', async () => {
      const created = await post(tokenA, { groupName: 'LOAN', headGroup: 'LIABILITIES' });
      const res = await put(tokenA, created.json().data.id, { groupName: 'LOAN', headGroup: 'ASSETS' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.headGroup).toBe('ASSETS');
    });

    it("refuses to rename a group onto another group's name", async () => {
      await post(tokenA, { groupName: 'CLIENT', headGroup: 'LIABILITIES' });
      const other = await post(tokenA, { groupName: 'EXPOSER/PARTY', headGroup: 'LIABILITIES' });
      expect((await put(tokenA, other.json().data.id, { groupName: 'client' })).statusCode).toBe(400);
    });
  });

  describe('update', () => {
    it('reclassifies a group without touching its name', async () => {
      const created = await post(tokenA, { groupName: 'RECLASSIFY ME', headGroup: 'OTHER' });
      const res = await put(tokenA, created.json().data.id, { headGroup: 'INCOME' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ groupName: 'RECLASSIFY ME', headGroup: 'INCOME' });
    });

    it('refuses to reclassify to an unsupported head group', async () => {
      const created = await post(tokenA, { groupName: 'STAYS PUT', headGroup: 'OTHER' });
      expect((await put(tokenA, created.json().data.id, { headGroup: 'CAPITAL' })).statusCode).toBe(400);
    });

    it('leaves isActive untouched when an update does not mention it', async () => {
      const created = await post(tokenA, { groupName: 'STAYS INACTIVE', headGroup: 'OTHER', isActive: false });
      expect((await put(tokenA, created.json().data.id, { headGroup: 'CASH' })).json().data.isActive).toBe(false);
    });
  });

  describe('list', () => {
    it('searches by group name', async () => {
      await post(tokenA, { groupName: 'SEARCHABLE GROUP', headGroup: 'OTHER' });
      const rows = (await get(tokenA, '?search=SEARCHABLE')).json().data.rows as { groupName: string }[];
      expect(rows.some((r) => r.groupName === 'SEARCHABLE GROUP')).toBe(true);
    });

    it('filters by head group', async () => {
      await post(tokenA, { groupName: 'FILTER INCOME', headGroup: 'INCOME' });
      const rows = (await get(tokenA, '?headGroup=INCOME&limit=100')).json().data.rows as { headGroup: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.headGroup === 'INCOME')).toBe(true);
    });

    /** An unknown head group must not silently drop the predicate and return everything. */
    it('ignores an unsupported head group filter rather than trusting it', async () => {
      const all = (await get(tokenA, '?limit=100')).json().data.total as number;
      expect((await get(tokenA, '?headGroup=CAPITAL&limit=100')).json().data.total).toBe(all);
    });

    it('filters by status', async () => {
      await post(tokenA, { groupName: 'INACTIVE FOR FILTER', headGroup: 'OTHER', isActive: false });
      const rows = (await get(tokenA, '?isActive=false&limit=100')).json().data.rows as { isActive: boolean }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.isActive === false)).toBe(true);
    });

    it('reports a total that matches the filter, not the whole table', async () => {
      const page = (await get(tokenA, '?headGroup=INCOME&limit=1')).json().data as { rows: unknown[]; total: number };
      const all = (await get(tokenA, '?headGroup=INCOME&limit=100')).json().data.rows as unknown[];
      expect(page.rows).toHaveLength(1);
      expect(page.total).toBe(all.length);
    });
  });

  describe('lookup', () => {
    it('returns only active groups, with just the fields a picker needs', async () => {
      await post(tokenA, { groupName: 'LOOKUP ACTIVE', headGroup: 'ASSETS' });
      const inactive = await post(tokenA, { groupName: 'LOOKUP INACTIVE', headGroup: 'ASSETS', isActive: false });
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/account-groups', headers: auth(tokenA) })).json().data as Record<string, unknown>[];
      expect(rows.some((r) => r.groupName === 'LOOKUP ACTIVE')).toBe(true);
      expect(rows.some((r) => r.id === inactive.json().data.id)).toBe(false);
      expect(Object.keys(rows[0]).sort()).toEqual(['groupName', 'headGroup', 'id']);
    });
  });

  describe('delete', () => {
    it('deletes an account group', async () => {
      const created = await post(tokenA, { groupName: 'DELETABLE', headGroup: 'OTHER' });
      expect((await del(tokenA, created.json().data.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${created.json().data.id}`)).statusCode).toBe(404);
    });
  });
});
