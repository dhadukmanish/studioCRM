import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { accountDetailFor, accountDetailKeys, accountDetailSchemas, accountSchema } from '@erp/shared';

/**
 * Account Master.
 *
 * Section A is pure validation and the group -> detail-block mapping — no database, always
 * runs. Section B needs a database and is skipped unless TEST_DATABASE_URL is set; it is where
 * the duplicate guard, tenant isolation, the dynamic detail blocks, the atomic account+detail
 * write and permission enforcement live.
 *
 * Account Master is an accounting FOUNDATION: nothing below asserts a posting, a ledger entry
 * or a calculated balance, because this phase implements none.
 */

/* --------------------------------------------------------------- helpers -- */

/** Minimal valid Account payload; override only what the test is about. */
const makeAccount = (overrides: Record<string, unknown> = {}) => ({
  accountGroupId: '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
  accountName: 'STATE BANK',
  ...overrides,
});

const parseAccount = (input: unknown, schema: ZodTypeAny = accountSchema) => schema.parse(input);

/** The issues zod raised, flattened to `{ path, message }` — fails if the input was accepted. */
function issuesFor(input: unknown, schema: ZodTypeAny = accountSchema) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error(`expected validation to fail, but it accepted ${JSON.stringify(input)}`);
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/* ------------------------------------------------- A. pure validation ----- */

describe('accountSchema (create payload)', () => {
  it('accepts a minimal account and fills in the opening balance defaults', () => {
    expect(parseAccount(makeAccount({ accountName: '  STATE BANK  ' }))).toEqual({
      accountGroupId: '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
      accountName: 'STATE BANK',
      openingAmount: 0,
      openingSide: 'DEBIT',
      remark: null,
      isActive: true,
    });
  });

  describe('accountGroupId', () => {
    it('is required — an account always belongs to exactly one group', () => {
      const body = makeAccount();
      delete (body as Record<string, unknown>).accountGroupId;
      expect(issuesFor(body)).toContainEqual({ path: 'accountGroupId', message: 'Account group is required' });
    });

    it('rejects an unselected picker', () => {
      expect(issuesFor(makeAccount({ accountGroupId: '' }))).toContainEqual({ path: 'accountGroupId', message: 'Account group is required' });
    });

    it('rejects a value that is not an id', () => {
      expect(issuesFor(makeAccount({ accountGroupId: 'BANK' }))).toContainEqual({ path: 'accountGroupId', message: 'Select a valid account group' });
    });
  });

  describe('accountName', () => {
    it('is required', () => {
      const body = makeAccount();
      delete (body as Record<string, unknown>).accountName;
      expect(issuesFor(body)).toContainEqual({ path: 'accountName', message: 'Required' });
    });

    it('rejects a whitespace-only name, because it is trimmed before it is measured', () => {
      expect(issuesFor(makeAccount({ accountName: '   ' }))).toContainEqual({ path: 'accountName', message: 'Account name is required' });
    });

    it('accepts a name of exactly 120 characters', () => {
      expect(parseAccount(makeAccount({ accountName: 'a'.repeat(120) }))).toMatchObject({ accountName: 'a'.repeat(120) });
    });

    it('rejects a name longer than 120 characters', () => {
      expect(issuesFor(makeAccount({ accountName: 'a'.repeat(121) }))).toContainEqual({ path: 'accountName', message: 'Account name cannot exceed 120 characters' });
    });
  });

  describe('openingAmount', () => {
    it('treats a blank field as no opening balance', () => {
      expect(parseAccount(makeAccount({ openingAmount: '' }))).toMatchObject({ openingAmount: 0 });
    });

    it('coerces a form string to a number', () => {
      expect(parseAccount(makeAccount({ openingAmount: '52723.00' }))).toMatchObject({ openingAmount: 52723 });
    });

    it('keeps two decimal places exactly', () => {
      expect(parseAccount(makeAccount({ openingAmount: '5000.55' }))).toMatchObject({ openingAmount: 5000.55 });
    });

    /** A credit balance is said with openingSide. A negative amount would be a second way to say it. */
    it('rejects a negative amount, because Credit is a side and not a minus sign', () => {
      expect(issuesFor(makeAccount({ openingAmount: '-100' }))).toContainEqual({ path: 'openingAmount', message: 'Opening amount cannot be negative' });
    });

    /** Silently dropping the third decimal would silently change the amount. */
    it('rejects a third decimal place rather than rounding it away', () => {
      expect(issuesFor(makeAccount({ openingAmount: '100.555' }))).toContainEqual({ path: 'openingAmount', message: 'Opening amount can have at most 2 decimal places' });
    });

    it('rejects text', () => {
      expect(issuesFor(makeAccount({ openingAmount: 'abc' }))).toContainEqual({ path: 'openingAmount', message: 'Opening amount must be a number' });
    });

    it('rejects an amount past the numeric(14, 2) ceiling', () => {
      expect(issuesFor(makeAccount({ openingAmount: '1000000000000' }))).toContainEqual({ path: 'openingAmount', message: 'Opening amount is too large' });
    });
  });

  describe('openingSide', () => {
    it.each(['DEBIT', 'CREDIT'])('accepts %s', (side) => {
      expect(parseAccount(makeAccount({ openingSide: side }))).toMatchObject({ openingSide: side });
    });

    it('defaults to DEBIT when the field is absent or blank', () => {
      expect(parseAccount(makeAccount())).toMatchObject({ openingSide: 'DEBIT' });
      expect(parseAccount(makeAccount({ openingSide: '' }))).toMatchObject({ openingSide: 'DEBIT' });
    });

    it.each(['Dr', 'debit', 'BOTH'])('rejects %p', (side) => {
      expect(issuesFor(makeAccount({ openingSide: side }))).toContainEqual({ path: 'openingSide', message: 'Opening side must be one of DEBIT, CREDIT' });
    });
  });

  describe('remark', () => {
    it('stores a blank remark as NULL, never as an empty string', () => {
      expect(parseAccount(makeAccount({ remark: '   ' }))).toMatchObject({ remark: null });
    });

    it('trims a remark that is present', () => {
      expect(parseAccount(makeAccount({ remark: '  main account  ' }))).toMatchObject({ remark: 'main account' });
    });
  });

  /** PUT goes through `.partial()`. Absent fields must stay absent. */
  describe('accountSchema.partial() (update payload)', () => {
    const partial = accountSchema.partial();

    it('accepts an empty patch', () => {
      expect(parseAccount({}, partial)).toEqual({});
    });

    it('does not re-apply the isActive default, so editing an inactive account leaves it inactive', () => {
      expect(parseAccount({ accountName: 'CASH IN HAND' }, partial)).toEqual({ accountName: 'CASH IN HAND' });
    });

    it('does not re-apply the opening balance defaults when the patch does not mention them', () => {
      const patched = parseAccount({ accountName: 'CASH IN HAND' }, partial);
      expect(patched).not.toHaveProperty('openingAmount');
      expect(patched).not.toHaveProperty('openingSide');
    });

    it('still rejects a bad opening amount that is present', () => {
      expect(issuesFor({ openingAmount: '-1' }, partial)).toContainEqual({ path: 'openingAmount', message: 'Opening amount cannot be negative' });
    });
  });
});

/* ------------------------------------------- the group -> block mapping --- */

describe('accountDetailFor (which detail block an account group drives)', () => {
  it.each([
    ['BANK', 'bank', 'Bank Details'],
    ['EMPLOYEE', 'employee', 'Employee Details'],
    ['LOAN', 'loan', 'Loan Details'],
    ['PARTNER', 'partner', 'Partner Details'],
    ['CLIENT', 'party', 'Client Details'],
    ['EXPOSER/PARTY', 'party', 'Party Details'],
  ])('maps %s to the %s block', (groupName, kind, title) => {
    expect(accountDetailFor(groupName)).toEqual({ kind, title });
  });

  /** CLIENT and EXPOSER/PARTY ask for the same fields, so they share one table — only the heading differs. */
  it('files CLIENT and EXPOSER/PARTY in the same storage block', () => {
    expect(accountDetailFor('CLIENT')?.kind).toBe(accountDetailFor('EXPOSER/PARTY')?.kind);
  });

  it.each(['CASH', 'INCOME', 'EXPENSES', 'DISCOUNT'])('gives %s the common fields only', (groupName) => {
    expect(accountDetailFor(groupName)).toBeNull();
  });

  it('gives a group the studio invented the common fields only, rather than failing', () => {
    expect(accountDetailFor('STUDIO EQUIPMENT FUND')).toBeNull();
  });

  it.each(['bank', '  Bank  ', 'exposer / party', 'Exposer/Party'])('matches %p despite case and spacing', (groupName) => {
    expect(accountDetailFor(groupName)).not.toBeNull();
  });

  it('never matches on the head group — BANK is filed under ASSETS, but ASSETS is not a bank', () => {
    expect(accountDetailFor('ASSETS')).toBeNull();
  });

  it('treats a missing group name as no block', () => {
    expect(accountDetailFor(null)).toBeNull();
    expect(accountDetailFor('')).toBeNull();
  });
});

describe('detail block validation', () => {
  it('keeps a bank account number as text, so leading zeros survive', () => {
    expect(accountDetailSchemas.bank.parse({ accountNumber: '000123456789' })).toMatchObject({ accountNumber: '000123456789' });
  });

  it('stores every blank detail field as NULL rather than as an empty string', () => {
    expect(accountDetailSchemas.bank.parse({ bankName: '  ', accountNumber: '' })).toEqual({ bankName: null, accountType: null, branch: null, accountNumber: null });
  });

  /** The form only ever sends the active block, and the API drops anything else on top of that. */
  it('drops a field belonging to another block instead of storing it', () => {
    expect(accountDetailSchemas.bank.parse({ bankName: 'HDFC', salary: '50000' })).not.toHaveProperty('salary');
  });

  it('keeps a salary at two decimals and refuses a third', () => {
    expect(accountDetailSchemas.employee.parse({ salary: '25000.50' })).toMatchObject({ salary: 25000.5 });
    expect(issuesFor({ salary: '25000.555' }, accountDetailSchemas.employee)).toContainEqual({ path: 'salary', message: 'Salary can have at most 2 decimal places' });
  });

  it('holds a contact number as text, never as a number', () => {
    expect(accountDetailSchemas.employee.parse({ contactNumber: '+91 98250 00000' })).toMatchObject({ contactNumber: '+91 98250 00000' });
  });

  it.each([
    ['interestRate', accountDetailSchemas.loan, 'Interest rate'],
    ['profitPercent', accountDetailSchemas.partner, 'Profit %'],
    ['lossPercent', accountDetailSchemas.partner, 'Loss %'],
  ])('validates %s as a percentage', (field, schema, label) => {
    expect(schema.parse({ [field]: '12.50' })).toMatchObject({ [field]: 12.5 });
    expect(issuesFor({ [field]: '101' }, schema)).toContainEqual({ path: field, message: `${label} cannot exceed 100` });
    expect(issuesFor({ [field]: '-1' }, schema)).toContainEqual({ path: field, message: `${label} cannot be negative` });
  });

  /** No business rule says a partner's profit and loss shares must add up to 100, so none is enforced. */
  it('accepts partner shares that do not total 100', () => {
    expect(accountDetailSchemas.partner.parse({ profitPercent: '40', lossPercent: '25' })).toMatchObject({ profitPercent: 40, lossPercent: 25 });
  });

  it('validates a party email only when one was entered', () => {
    expect(accountDetailSchemas.party.parse({ email: '' })).toMatchObject({ email: null });
    expect(accountDetailSchemas.party.parse({ email: 'studio@example.com' })).toMatchObject({ email: 'studio@example.com' });
    expect(issuesFor({ email: 'not-an-email' }, accountDetailSchemas.party)).toContainEqual({ path: 'email', message: 'Enter a valid email address' });
  });

  it('holds a party GST and PAN as text, and computes nothing from them', () => {
    expect(accountDetailSchemas.party.parse({ gst: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' })).toMatchObject({ gst: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A' });
  });

  it('takes an item reference, not copied item text', () => {
    expect(accountDetailKeys('party')).toContain('itemId');
    expect(accountDetailKeys('party')).not.toContain('itemName');
    expect(issuesFor({ itemId: 'Photography' }, accountDetailSchemas.party)).toContainEqual({ path: 'itemId', message: 'Select a valid item' });
  });

  /**
   * Guards the business reference: these are the fields the legacy screens show. Quietly adding
   * or dropping one would change what the studio can record about an account.
   */
  it('implements exactly the documented fields per block', () => {
    expect(accountDetailKeys('bank')).toEqual(['bankName', 'accountType', 'branch', 'accountNumber']);
    expect(accountDetailKeys('employee')).toEqual(['employeeName', 'address', 'contactNumber', 'salaryType', 'salary', 'designation', 'commission']);
    expect(accountDetailKeys('loan')).toEqual(['interestRate']);
    expect(accountDetailKeys('partner')).toEqual(['mobileNumber', 'profitPercent', 'lossPercent']);
    expect(accountDetailKeys('party')).toEqual(['partyName', 'address', 'contactNumber', 'gst', 'panNo', 'rate', 'email', 'itemId']);
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Tenant isolation, permission enforcement, the duplicate-name guard, the dynamic detail
 * blocks and the atomic account+detail write can only be proved against a real database, so
 * this suite is SKIPPED unless TEST_DATABASE_URL is set.
 *
 * Point it at a THROWAWAY database only. It creates and deletes tenants, roles, users, items,
 * account groups and accounts, and must never run against the shared hosted DATABASE_URL in
 * apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Account Master API (integration, needs TEST_DATABASE_URL)', () => {
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
  /** Tenant A's account groups, by name. */
  const groupA: Record<string, string> = {};
  let itemA = '';
  let itemB = '';
  let groupB = '';
  let accountB = '';

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/masters/accounts', headers: auth(token), payload: payload as object });
  const put = (token: string, id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/masters/accounts/${id}`, headers: auth(token), payload: payload as object });
  const del = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/api/masters/accounts/${id}`, headers: auth(token) });
  const get = (token: string, path = '') => app.inject({ method: 'GET', url: `/api/masters/accounts${path}`, headers: auth(token) });

  /** Create an account under one of tenant A's groups, named uniquely for the calling test. */
  const create = (group: string, accountName: string, rest: Record<string, unknown> = {}, token = tokenA) =>
    post(token, { accountGroupId: groupA[group], accountName, ...rest });

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

  const makeGroup = async (token: string, groupName: string, headGroup: string) =>
    (await app.inject({ method: 'POST', url: '/api/masters/account-groups', headers: auth(token), payload: { groupName, headGroup } })).json().data.id as string;
  const makeItem = async (token: string, itemName: string) =>
    (await app.inject({ method: 'POST', url: '/api/masters/items', headers: auth(token), payload: { itemName, hsnCode: '9983', gstRate: 18 } })).json().data.id as string;

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

    const full = {
      masters_accounts: ['read', 'create', 'update', 'delete'],
      masters_account_groups: ['read', 'create', 'update', 'delete'],
      masters_items: ['read', 'create', 'update', 'delete'],
    };
    ({ token: tokenA } = await seedTenant('acc-tenant-a', full));
    ({ token: tokenAReadOnly } = await seedTenant('acc-tenant-a-readonly', { masters_accounts: ['read'] }));
    ({ token: tokenB } = await seedTenant('acc-tenant-b', full));

    // The legacy group set, plus one the studio invented — every branch of the mapping.
    for (const [name, head] of [
      ['CASH', 'CASH'], ['BANK', 'ASSETS'], ['EMPLOYEE', 'EXPENSES'], ['LOAN', 'LIABILITIES'],
      ['PARTNER', 'LIABILITIES'], ['CLIENT', 'ASSETS'], ['EXPOSER/PARTY', 'ASSETS'],
      ['INCOME', 'INCOME'], ['EXPENSES', 'EXPENSES'], ['DISCOUNT', 'EXPENSES'], ['STUDIO EQUIPMENT FUND', 'OTHER'],
    ] as const) {
      groupA[name] = await makeGroup(tokenA, name, head);
    }
    itemA = await makeItem(tokenA, 'Photography');

    groupB = await makeGroup(tokenB, 'BANK', 'ASSETS');
    itemB = await makeItem(tokenB, 'Tenant B Item');
    accountB = (await post(tokenB, { accountGroupId: groupB, accountName: 'TENANT B ACCOUNT' })).json().data.id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      // accounts first: the group and item references are RESTRICT, and detail rows cascade.
      await db.delete(schema.accounts).where(inArray(schema.accounts.tenantId, tenantIds));
      await db.delete(schema.accountGroups).where(inArray(schema.accountGroups.tenantId, tenantIds));
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
    it('creates an account under its group and reports the group back without storing a copy', async () => {
      const res = await create('CASH', 'CASH IN HAND', { openingAmount: '52723.00', openingSide: 'DEBIT' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ accountName: 'CASH IN HAND', groupName: 'CASH', headGroup: 'CASH', openingAmount: 52723, openingSide: 'DEBIT', isActive: true });
    });

    it('defaults an account with no opening balance to 0 Dr', async () => {
      const res = await create('INCOME', 'SHOOT INCOME');
      expect(res.json().data).toMatchObject({ openingAmount: 0, openingSide: 'DEBIT' });
    });

    it('keeps a credit opening balance positive, with the side carrying the meaning', async () => {
      const res = await create('LOAN', 'VEHICLE LOAN', { openingAmount: '5000', openingSide: 'CREDIT' });
      expect(res.json().data).toMatchObject({ openingAmount: 5000, openingSide: 'CREDIT' });
    });

    it('stores an opening amount at exactly two decimals', async () => {
      const res = await create('CASH', 'PETTY CASH', { openingAmount: '26930.45' });
      expect(res.json().data.openingAmount).toBe(26930.45);
      expect((await get(tokenA, `/${res.json().data.id}`)).json().data.openingAmount).toBe(26930.45);
    });

    it('rejects a payload with no account group', async () => {
      expect((await post(tokenA, { accountName: 'NO GROUP' })).statusCode).toBe(400);
    });

    it('rejects an opening amount with three decimals rather than rounding it', async () => {
      expect((await create('CASH', 'TOO PRECISE', { openingAmount: '10.005' })).statusCode).toBe(400);
    });

    it('rejects an opening side other than DEBIT or CREDIT', async () => {
      expect((await create('CASH', 'BAD SIDE', { openingSide: 'Dr' })).statusCode).toBe(400);
    });
  });

  describe('the account group drives the detail block', () => {
    it.each(['CASH', 'INCOME', 'EXPENSES', 'DISCOUNT'])('gives a %s account the common fields only', async (group) => {
      const created = await create(group, `${group} COMMON ONLY`);
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detailKind).toBeNull();
      expect(record.detail).toBeNull();
    });

    it('gives a group the studio invented the common fields only, and does not fail', async () => {
      const created = await create('STUDIO EQUIPMENT FUND', 'CAMERA FUND', { openingAmount: '1000' });
      expect(created.statusCode).toBe(200);
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record).toMatchObject({ detailKind: null, detail: null, groupName: 'STUDIO EQUIPMENT FUND', headGroup: 'OTHER' });
    });

    it('stores and returns Bank Details, keeping the account number as text', async () => {
      const created = await create('BANK', 'HDFC CURRENT', { detail: { bankName: 'HDFC Bank', accountType: 'Current', branch: 'Ring Road', accountNumber: '000123456789' } });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detailKind).toBe('bank');
      expect(record.detail).toMatchObject({ bankName: 'HDFC Bank', accountType: 'Current', branch: 'Ring Road', accountNumber: '000123456789' });
    });

    it('updates Bank Details in place', async () => {
      const created = await create('BANK', 'SBI SAVINGS', { detail: { bankName: 'SBI', branch: 'Old Branch' } });
      await put(tokenA, created.json().data.id, { detail: { bankName: 'SBI', branch: 'New Branch', accountNumber: '9988' } });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detail).toMatchObject({ branch: 'New Branch', accountNumber: '9988' });
    });

    it('stores Employee Details, with salary and commission at fixed precision', async () => {
      const created = await create('EMPLOYEE', 'RAHUL PHOTOGRAPHER', {
        detail: { employeeName: 'Rahul', address: 'Rajkot', contactNumber: '+91 98250 00000', salaryType: 'Monthly', salary: '25000.50', designation: 'Photographer', commission: '5' },
      });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detailKind).toBe('employee');
      expect(record.detail).toMatchObject({ employeeName: 'Rahul', contactNumber: '+91 98250 00000', salaryType: 'Monthly', salary: 25000.5, designation: 'Photographer', commission: 5 });
    });

    it('stores a Loan interest rate without calculating any interest from it', async () => {
      const created = await create('LOAN', 'STUDIO EQUIPMENT LOAN', { openingAmount: '100000', openingSide: 'CREDIT', detail: { interestRate: '12.50' } });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detail).toMatchObject({ interestRate: 12.5 });
      // nothing derived: the account carries what was entered and no more
      expect(record).not.toHaveProperty('currentBalance');
    });

    it('stores Partner Details', async () => {
      const created = await create('PARTNER', 'PARTNER MEHUL', { detail: { mobileNumber: '9825000000', profitPercent: '60', lossPercent: '60' } });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detail).toMatchObject({ mobileNumber: '9825000000', profitPercent: 60, lossPercent: 60 });
    });

    it('stores Client Details with an Item Master reference rather than copied item text', async () => {
      const created = await create('CLIENT', 'SHARMA WEDDING', {
        detail: { partyName: 'Sharma', address: 'Ahmedabad', contactNumber: '9825011111', gst: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A', rate: '15000.00', email: 'sharma@example.com', itemId: itemA },
      });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detailKind).toBe('party');
      expect(record.detail).toMatchObject({ partyName: 'Sharma', gst: '24AAAAA0000A1Z5', panNo: 'AAAAA0000A', rate: 15000, email: 'sharma@example.com', itemId: itemA, itemName: 'Photography' });
    });

    it('stores Party Details for EXPOSER/PARTY the same way it does for CLIENT', async () => {
      const created = await create('EXPOSER/PARTY', 'PARTY STUDIO ONE', { detail: { partyName: 'Studio One', rate: '2500', itemId: itemA } });
      const record = (await get(tokenA, `/${created.json().data.id}`)).json().data;
      expect(record.detailKind).toBe('party');
      expect(record.detail).toMatchObject({ partyName: 'Studio One', rate: 2500, itemId: itemA });
    });

    it('rejects a detail field that fails its own validation, without creating the account', async () => {
      const res = await create('CLIENT', 'BAD EMAIL CLIENT', { detail: { partyName: 'X', email: 'nope' } });
      expect(res.statusCode).toBe(400);
      const rows = (await get(tokenA, '?search=BAD EMAIL CLIENT&limit=100')).json().data.rows as unknown[];
      expect(rows).toHaveLength(0);
    });
  });

  describe('changing the account group', () => {
    it('clears the old block when the group moves to one that drives a different block', async () => {
      const created = await create('BANK', 'MOVES TO CASH', { detail: { bankName: 'HDFC', accountNumber: '12345' } });
      const id = created.json().data.id;
      await put(tokenA, id, { accountGroupId: groupA.CASH });
      const record = (await get(tokenA, `/${id}`)).json().data;
      expect(record).toMatchObject({ groupName: 'CASH', detailKind: null, detail: null });
    });

    /** The stale values must not reach the database even when the browser still sends them. */
    it('ignores a detail block the new group does not drive', async () => {
      const created = await create('BANK', 'STALE BANK DATA', { detail: { bankName: 'HDFC', accountNumber: '12345' } });
      const id = created.json().data.id;
      const res = await put(tokenA, id, { accountGroupId: groupA.CASH, detail: { bankName: 'HDFC', accountNumber: '12345' } });
      expect(res.statusCode).toBe(200);
      expect((await get(tokenA, `/${id}`)).json().data.detail).toBeNull();
    });

    it('moves the data to the new block when the group changes to another kind', async () => {
      const created = await create('BANK', 'BANK THEN EMPLOYEE', { detail: { bankName: 'HDFC' } });
      const id = created.json().data.id;
      await put(tokenA, id, { accountGroupId: groupA.EMPLOYEE, detail: { employeeName: 'Rahul', salary: '20000' } });
      const record = (await get(tokenA, `/${id}`)).json().data;
      expect(record.detailKind).toBe('employee');
      expect(record.detail).toMatchObject({ employeeName: 'Rahul', salary: 20000 });
      expect(record.detail).not.toHaveProperty('bankName');
    });

    /** CLIENT and EXPOSER/PARTY share their fields, so moving between them keeps what was entered. */
    it('keeps the details when the group changes between CLIENT and EXPOSER/PARTY', async () => {
      const created = await create('CLIENT', 'CLIENT TO PARTY', { detail: { partyName: 'Sharma', rate: '500' } });
      const id = created.json().data.id;
      await put(tokenA, id, { accountGroupId: groupA['EXPOSER/PARTY'] });
      const record = (await get(tokenA, `/${id}`)).json().data;
      expect(record).toMatchObject({ groupName: 'EXPOSER/PARTY', detailKind: 'party' });
      expect(record.detail).toMatchObject({ partyName: 'Sharma', rate: 500 });
    });

    /** Absent is not the same as empty: a patch that says nothing about the block keeps it. */
    it('leaves the detail block alone when an update does not mention it', async () => {
      const created = await create('BANK', 'PATCH WITHOUT DETAIL', { detail: { bankName: 'HDFC', accountNumber: '4321' } });
      const id = created.json().data.id;
      await put(tokenA, id, { isActive: false });
      const record = (await get(tokenA, `/${id}`)).json().data;
      expect(record.isActive).toBe(false);
      expect(record.detail).toMatchObject({ bankName: 'HDFC', accountNumber: '4321' });
    });

    it('clears every field of the block when an empty block is sent', async () => {
      const created = await create('BANK', 'CLEARED DETAIL', { detail: { bankName: 'HDFC', accountNumber: '4321' } });
      const id = created.json().data.id;
      await put(tokenA, id, { detail: {} });
      expect((await get(tokenA, `/${id}`)).json().data.detail).toMatchObject({ bankName: null, accountNumber: null });
    });

    /** A failed detail write must not leave a half-updated account behind. */
    it('leaves the account untouched when the new detail is invalid', async () => {
      const created = await create('BANK', 'ATOMIC UPDATE', { detail: { bankName: 'HDFC' } });
      const id = created.json().data.id;
      const res = await put(tokenA, id, { accountGroupId: groupA.CLIENT, accountName: 'RENAMED', detail: { email: 'nope' } });
      expect(res.statusCode).toBe(400);
      const record = (await get(tokenA, `/${id}`)).json().data;
      expect(record).toMatchObject({ accountName: 'ATOMIC UPDATE', groupName: 'BANK' });
      expect(record.detail).toMatchObject({ bankName: 'HDFC' });
    });
  });

  describe('duplicate account names', () => {
    it('refuses a second account with the same name in the same tenant', async () => {
      await create('CASH', 'DUPLICATE ME');
      const res = await create('CASH', 'DUPLICATE ME');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('An account named "DUPLICATE ME" already exists');
    });

    it('treats account names case-insensitively', async () => {
      await create('CASH', 'CASE TEST');
      expect((await create('CASH', 'case test')).statusCode).toBe(400);
    });

    /** The name is the business key, not the (group, name) pair. */
    it('refuses a duplicate name even under a different account group', async () => {
      await create('CASH', 'ACROSS GROUPS');
      expect((await create('BANK', 'ACROSS GROUPS')).statusCode).toBe(400);
    });

    it('allows the same account name in a different tenant', async () => {
      await create('CASH', 'SHARED ACROSS TENANTS');
      expect((await post(tokenB, { accountGroupId: groupB, accountName: 'SHARED ACROSS TENANTS' })).statusCode).toBe(200);
    });

    it('lets an account keep its own name when it is updated', async () => {
      const created = await create('CASH', 'KEEPS ITS NAME');
      expect((await put(tokenA, created.json().data.id, { accountName: 'KEEPS ITS NAME', openingAmount: '10' })).statusCode).toBe(200);
    });
  });

  describe('tenant isolation', () => {
    it("refuses an account group belonging to another tenant", async () => {
      const res = await post(tokenA, { accountGroupId: groupB, accountName: 'CROSS TENANT GROUP' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Select a valid account group');
    });

    it("refuses an item belonging to another tenant", async () => {
      const res = await create('CLIENT', 'CROSS TENANT ITEM', { detail: { partyName: 'X', itemId: itemB } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Select a valid item');
    });

    it("cannot read another tenant's account by id", async () => {
      expect((await get(tokenA, `/${accountB}`)).statusCode).toBe(404);
    });

    it("cannot update another tenant's account", async () => {
      expect((await put(tokenA, accountB, { accountName: 'HIJACKED' })).statusCode).toBe(404);
    });

    it("cannot delete another tenant's account", async () => {
      expect((await del(tokenA, accountB)).statusCode).toBe(404);
    });

    it("never lists another tenant's accounts", async () => {
      const rows = (await get(tokenA, '?limit=200')).json().data.rows as { id: string }[];
      expect(rows.some((r) => r.id === accountB)).toBe(false);
    });

    it('keeps the lookup tenant-scoped too', async () => {
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/accounts', headers: auth(tokenA) })).json().data as { id: string }[];
      expect(rows.some((r) => r.id === accountB)).toBe(false);
    });
  });

  describe('authorization', () => {
    it('rejects an unauthenticated request', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/masters/accounts' })).statusCode).toBe(401);
    });

    it('refuses to create for a role granted only read on masters_accounts', async () => {
      const res = await post(tokenAReadOnly, { accountGroupId: groupA.CASH, accountName: 'SHOULD NOT EXIST' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain('create permission for masters_accounts');
    });

    it('refuses to update for a role granted only read', async () => {
      const created = await create('CASH', 'GUARDED UPDATE');
      expect((await put(tokenAReadOnly, created.json().data.id, { accountName: 'NOPE' })).statusCode).toBe(403);
    });

    it('refuses to delete for a role granted only read', async () => {
      const created = await create('CASH', 'GUARDED DELETE');
      expect((await del(tokenAReadOnly, created.json().data.id)).statusCode).toBe(403);
    });
  });

  describe('list', () => {
    it('carries each row’s group name and head group, joined rather than copied', async () => {
      await create('BANK', 'JOINED ROW');
      const rows = (await get(tokenA, '?search=JOINED ROW')).json().data.rows as Record<string, unknown>[];
      expect(rows[0]).toMatchObject({ accountName: 'JOINED ROW', groupName: 'BANK', headGroup: 'ASSETS' });
    });

    it('searches by account name', async () => {
      await create('CASH', 'SEARCHABLE ACCOUNT');
      const rows = (await get(tokenA, '?search=SEARCHABLE')).json().data.rows as { accountName: string }[];
      expect(rows.some((r) => r.accountName === 'SEARCHABLE ACCOUNT')).toBe(true);
    });

    it('searches by account group name too', async () => {
      await create('EXPOSER/PARTY', 'FOUND BY GROUP NAME');
      const rows = (await get(tokenA, '?search=EXPOSER&limit=100')).json().data.rows as { accountName: string }[];
      expect(rows.some((r) => r.accountName === 'FOUND BY GROUP NAME')).toBe(true);
    });

    it('filters by account group', async () => {
      await create('DISCOUNT', 'FILTERED BY GROUP');
      const rows = (await get(tokenA, `?accountGroupId=${groupA.DISCOUNT}&limit=100`)).json().data.rows as { groupName: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.groupName === 'DISCOUNT')).toBe(true);
    });

    /** A malformed id must narrow the list to nothing, not raise a database error. */
    it('survives an account group filter that is not an id', async () => {
      expect((await get(tokenA, '?accountGroupId=BANK&limit=100')).statusCode).toBe(200);
    });

    it('filters by status', async () => {
      await create('CASH', 'INACTIVE FOR FILTER', { isActive: false });
      const rows = (await get(tokenA, '?isActive=false&limit=100')).json().data.rows as { isActive: boolean }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.isActive === false)).toBe(true);
    });

    it('reports a total that matches the filter, not the whole table', async () => {
      const page = (await get(tokenA, `?accountGroupId=${groupA.BANK}&limit=1`)).json().data as { rows: unknown[]; total: number };
      const all = (await get(tokenA, `?accountGroupId=${groupA.BANK}&limit=200`)).json().data.rows as unknown[];
      expect(page.rows).toHaveLength(1);
      expect(page.total).toBe(all.length);
    });

    it('keeps the detail blocks out of the list', async () => {
      const rows = (await get(tokenA, '?search=HDFC CURRENT')).json().data.rows as Record<string, unknown>[];
      expect(rows[0]).not.toHaveProperty('detail');
      expect(rows[0]).not.toHaveProperty('accountNumber');
    });
  });

  describe('lookup', () => {
    it('returns only active accounts, with just the fields a picker needs', async () => {
      const inactive = await create('CASH', 'LOOKUP INACTIVE', { isActive: false });
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/accounts', headers: auth(tokenA) })).json().data as Record<string, unknown>[];
      expect(rows.some((r) => r.id === inactive.json().data.id)).toBe(false);
      expect(Object.keys(rows[0]).sort()).toEqual(['accountGroupId', 'accountName', 'groupName', 'headGroup', 'id']);
    });

    /** Bank account numbers, salaries, PAN and GST must not leak through a list any user may read. */
    it('never exposes account detail', async () => {
      const rows = (await app.inject({ method: 'GET', url: '/api/common/lookups/accounts', headers: auth(tokenA) })).json().data as Record<string, unknown>[];
      for (const key of ['accountNumber', 'salary', 'panNo', 'gst', 'commission']) {
        expect(rows.every((r) => !(key in r))).toBe(true);
      }
    });
  });

  describe('delete', () => {
    it('deletes an account', async () => {
      const created = await create('CASH', 'DELETABLE');
      expect((await del(tokenA, created.json().data.id)).statusCode).toBe(200);
      expect((await get(tokenA, `/${created.json().data.id}`)).statusCode).toBe(404);
    });

    it('takes the detail block with it', async () => {
      const created = await create('BANK', 'DELETABLE WITH DETAIL', { detail: { bankName: 'HDFC' } });
      const id = created.json().data.id;
      await del(tokenA, id);
      const rows = await db.select().from(schema.accountBankDetails).where(inArray(schema.accountBankDetails.accountId, [id]));
      expect(rows).toHaveLength(0);
    });
  });
});
