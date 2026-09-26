import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { publicLinkCreateSchema, starterInvoiceTemplates } from '@erp/shared';
import { PUBLIC_TOKEN_PATTERN, hashToken, publicLinkConfig, redactPublicToken, tokenFor } from '../services/publicInvoiceLinks';
import { fixedWindowLimiter } from '../lib/rateLimit';
import { publicInvoiceRoutes } from './publicInvoice';

/**
 * Public invoice links (Phase 5.1, docs/WHATSAPP_SHARING.md).
 *
 * Section A always runs: token shape and entropy, hash-only storage, log redaction, the base-URL
 * and secret configuration, the rate limiter, and the public route's refusal of malformed tokens
 * (which never reaches the database).
 *
 * Section B needs TEST_DATABASE_URL (a THROWAWAY database): the lifecycle — create, reuse, replace,
 * revoke on bill edit / template edit / operator — the public PDF, stale revisions, tenant
 * isolation, RBAC, concurrency and the promise that no link operation moves a bill figure or counter.
 */

const SECRET = 'test-link-secret-0123456789-abcdefghijklmnop';
const ENV_KEYS = ['PUBLIC_APP_URL', 'PUBLIC_LINK_SECRET'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
};

/* ------------------------------------------------ A. pure behaviour -- */

describe('link tokens', () => {
  it('are 32 URL-safe characters (192 bits) and carry no id, number or customer', () => {
    const id = randomUUID();
    const t = tokenFor(SECRET, id);
    expect(t).toMatch(PUBLIC_TOKEN_PATTERN);
    expect(Buffer.from(t, 'base64url')).toHaveLength(24);
    expect(t).not.toContain(id.slice(0, 8));
  });

  it('are rebuilt only with the secret: same id + secret = same token; another secret or id = another token', () => {
    const id = randomUUID();
    expect(tokenFor(SECRET, id)).toBe(tokenFor(SECRET, id));
    expect(tokenFor(`${SECRET}x`, id)).not.toBe(tokenFor(SECRET, id));
    expect(tokenFor(SECRET, randomUUID())).not.toBe(tokenFor(SECRET, id));
  });

  it('do not repeat across many links', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => tokenFor(SECRET, randomUUID())));
    expect(seen.size).toBe(5000);
  });

  it('are stored as a SHA-256 hex hash, never as themselves', () => {
    const t = tokenFor(SECRET, randomUUID());
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashToken(t)).toBe(h);
  });

  it('never reach a log: the URL is redacted', () => {
    const t = tokenFor(SECRET, randomUUID());
    expect(redactPublicToken(`/i/${t}`)).toBe('/i/[redacted]');
    expect(redactPublicToken(`/i/${t}?x=1`)).toBe('/i/[redacted]?x=1');
    expect(redactPublicToken('/api/bills/1')).toBe('/api/bills/1');
  });

  it('the create body takes a template id and nothing else', () => {
    expect(publicLinkCreateSchema.parse({})).toEqual({});
    expect(publicLinkCreateSchema.safeParse({ templateId: null, billId: 'x' }).success).toBe(false);
    expect(publicLinkCreateSchema.safeParse({ mobileNumber: '9876543210' }).success).toBe(false);
  });
});

describe('publicLinkConfig — where links point, from configuration only', () => {
  afterEach(restoreEnv);
  // No default for the secret: an explicit undefined must mean "unset".
  const set = (url: string | undefined, secret: string | undefined) => {
    if (url === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = url;
    if (secret === undefined) delete process.env.PUBLIC_LINK_SECRET;
    else process.env.PUBLIC_LINK_SECRET = secret;
  };

  it('uses the configured https origin, without a trailing slash', () => {
    set('https://studio.example.com/', SECRET);
    expect(publicLinkConfig()).toEqual({ baseUrl: 'https://studio.example.com', secret: SECRET });
    set('https://studio.example.com', SECRET);
    expect(publicLinkConfig().baseUrl).toBe('https://studio.example.com');
  });

  it('refuses a path: /i/:token lives at the root, so a path would make every link dead', () => {
    set('https://studio.example.com/crm/', SECRET);
    expect(() => publicLinkConfig()).toThrow(/not set up/);
  });

  it('allows http only for local development', () => {
    set('http://localhost:5173', SECRET);
    expect(publicLinkConfig().baseUrl).toBe('http://localhost:5173');
    set('http://studio.example.com', SECRET);
    expect(() => publicLinkConfig()).toThrow(/not set up/);
  });

  it('refuses to make links when unset, malformed, carrying credentials/query, or with a short secret', () => {
    for (const [url, secret] of [[undefined, SECRET], ['not a url', SECRET], ['https://u:p@studio.example.com', SECRET], ['https://studio.example.com/?a=1', SECRET], ['https://studio.example.com', 'short'], ['https://studio.example.com', undefined]] as const) {
      set(url, secret);
      let err: unknown = null;
      try {
        publicLinkConfig();
      } catch (e) {
        err = e;
      }
      expect(err, `${url} / ${secret}`).toMatchObject({ statusCode: 503, code: 'PUBLIC_LINK_NOT_CONFIGURED' });
    }
  });
});

describe('fixedWindowLimiter', () => {
  it('allows the limit per key per window, then refuses until the window passes', () => {
    const allow = fixedWindowLimiter({ limit: 3, windowMs: 1000 });
    expect([1, 2, 3, 4].map(() => allow('a', 0))).toEqual([true, true, true, false]);
    expect(allow('b', 0)).toBe(true);
    expect(allow('a', 1000)).toBe(true);
  });

  it('cannot grow without bound', () => {
    const allow = fixedWindowLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });
    for (let i = 0; i < 100; i++) expect(allow(`k${i}`, 0)).toBe(true);
  });
});

describe('GET /i/:token — malformed tokens (no database involved)', () => {
  let app: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    app = Fastify();
    await app.register(publicInvoiceRoutes);
    await app.ready();
  });
  afterAll(() => app.close());

  it('answers the same calm HTML page for every malformed token, with no internals', async () => {
    const bodies = new Set<string>();
    for (const bad of ['1', 'abc', 'x'.repeat(31), 'x'.repeat(33), '%3Cscript%3E', `${'a'.repeat(31)}%21`]) {
      const res = await app.inject({ method: 'GET', url: `/i/${bad}`, remoteAddress: '10.0.0.1' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('Invoice link no longer valid');
      expect(res.body).not.toMatch(/script|stack|sql|tenant|error/i);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });

  it('never rate-limits by client for invalid tokens — one noisy client cannot lock customers out', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await app.inject({ method: 'GET', url: '/i/nope', remoteAddress: '10.0.0.2', headers: { 'x-forwarded-for': `1.2.3.${i}` } })).statusCode);
    expect(codes.every((c) => c === 404)).toBe(true);
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Point it at a THROWAWAY database only — it creates and deletes tenants, templates and bills.
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Public invoice links (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;
  let eq: typeof import('drizzle-orm').eq;
  let and: typeof import('drizzle-orm').and;
  let isNull: typeof import('drizzle-orm').isNull;

  const BASE = 'https://studio.example';
  const tenantIds: string[] = [];
  const starters = starterInvoiceTemplates();
  type Seeded = Awaited<ReturnType<typeof seedTenant>>;
  let A: Seeded & { billingOnly: string; billingUpdate: string; templatesRead: string; classic: string; compact: string };
  let Bt: Seeded;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const req = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: auth(t), payload });
  const link = (t: string, billId: string, templateId?: string) => req(t, 'POST', `/api/bills/${billId}/invoice/public-link`, templateId ? { templateId } : {});
  const state = async (t: string, billId: string) => (await req(t, 'GET', `/api/bills/${billId}/invoice/public-link`)).json().data;
  const open = (url: string) => app.inject({ method: 'GET', url: new URL(url).pathname, remoteAddress: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const active = async (billId: string) => db.select().from(schema.publicInvoiceLinks).where(and(eq(schema.publicInvoiceLinks.billId, billId), isNull(schema.publicInvoiceLinks.revokedAt)));

  async function seedTenant(name: string) {
    const { seedTenantDefaults } = await import('../services/tenant-setup');
    const [tenant] = await db.insert(schema.tenants).values({ name, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    await seedTenantDefaults(db, tenant.id, { companyName: `${name} Studio` });
    const user = async (grants: Record<string, string[]>) => {
      const [role] = await db.insert(schema.roles).values({ tenantId: tenant.id, name: `${name} ${Math.random().toString(36).slice(2, 8)}`, permissions: grants }).returning();
      const [u] = await db.insert(schema.users).values({ tenantId: tenant.id, roleId: role.id, firstName: name, lastName: 'T', email: `${name}-${Math.random().toString(36).slice(2, 8)}@test.local`, passwordHash: 'x' }).returning();
      return app.jwt.sign({ sub: u.id, tenantId: tenant.id });
    };
    const [book] = await db.insert(schema.books).values({ tenantId: tenant.id, bookNumber: '2026-27', seriesStartsAt: 1, nextBillNumber: 1 }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId: tenant.id, itemName: 'Photography', hsnCode: '9983', gstRate: '12.00' }).returning();
    const [sub] = await db.insert(schema.subItems).values({ tenantId: tenant.id, itemId: item.id, productName: 'Newborn Shoot', rate: '10000.00' }).returning();
    const admin = await user({ operations_billing: ['read', 'create', 'update', 'delete'], settings_invoice_templates: ['read', 'create', 'update', 'delete'] });
    const billBody = (over: Record<string, unknown> = {}) => ({ bookId: book.id, billDate: '2026-09-25', customerName: 'Link Customer', mobileNumber: '9876543210', taxMode: 'WITH_GST', discountType: 'NONE', discountValue: 0, items: [{ itemId: item.id, subItemId: sub.id, quantity: 1, rate: 10000 }], ...over });
    const bill = async (over: Record<string, unknown> = {}) => (await req(admin, 'POST', '/api/bills', billBody(over))).json().data.id as string;
    return { tenantId: tenant.id, admin, user, bookId: book.id, itemId: item.id, subItemId: sub.id, billBody, bill };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    process.env.PUBLIC_APP_URL = BASE;
    process.env.PUBLIC_LINK_SECRET = SECRET;
    ({ inArray, eq, and, isNull } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    ({ db, sql: sqlClient, schema } = client);
    app = await (await import('../server')).buildApp();
    await app.ready();
    const a = await seedTenant('lnk-a');
    const tpl = (await req(a.admin, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string }[];
    A = {
      ...a,
      billingOnly: await a.user({ operations_billing: ['read'] }),
      billingUpdate: await a.user({ operations_billing: ['read', 'update'] }),
      templatesRead: await a.user({ settings_invoice_templates: ['read'] }),
      classic: tpl.find((t) => t.templateName === 'Classic')!.id,
      compact: tpl.find((t) => t.templateName === 'Compact')!.id,
    };
    Bt = await seedTenant('lnk-b');
  });

  afterAll(async () => {
    restoreEnv();
    if (tenantIds.length) {
      for (const t of [schema.publicInvoiceLinks, schema.billItems, schema.bills, schema.subItems, schema.items, schema.books, schema.invoiceTemplates, schema.companyLogos, schema.branches, schema.companies, schema.appSettings, schema.activityLogs, schema.users, schema.roles] as const) {
        await db.delete(t).where(inArray((t as any).tenantId, tenantIds));
      }
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('lifecycle', () => {
    it('opening the dialog creates nothing; a new bill has no link', async () => {
      const billId = await A.bill();
      expect(await state(A.admin, billId)).toEqual({ active: false, url: null, templateId: null, templateName: null, createdAt: null });
      expect(await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId))).toHaveLength(0);
    });

    it('creates a compact opaque URL on the configured origin, stores only the hash, and opens the PDF without login', async () => {
      const billId = await A.bill();
      const res = await link(A.billingOnly, billId);
      expect(res.statusCode).toBe(200);
      const l = res.json().data;
      expect(l).toMatchObject({ active: true, outcome: 'CREATED', templateId: A.classic, templateName: 'Classic' });
      const token = l.url.slice(`${BASE}/i/`.length);
      expect(l.url).toBe(`${BASE}/i/${token}`);
      expect(token).toMatch(PUBLIC_TOKEN_PATTERN);
      expect(l.url).not.toContain(billId);
      expect(l.url).not.toContain(A.tenantId);

      const rows = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(rows)).not.toContain(token);

      const pdf = await open(l.url);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['content-disposition']).toBe('inline; filename="Invoice-2026-27-' + (await billNumber(billId)) + '.pdf"');
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      // The very same document the authenticated download gives.
      const authed = await req(A.admin, 'GET', `/api/bills/${billId}/invoice/pdf?templateId=${A.classic}`);
      expect(Buffer.compare(pdf.rawPayload, authed.rawPayload)).toBe(0);

      const logs = await db.select().from(schema.activityLogs).where(eq(schema.activityLogs.entityId, billId));
      const created = logs.find((x) => x.action === 'invoice_public_link_created')!;
      expect(created.meta).toMatchObject({ linkId: rows[0].id, templateName: 'Classic' });
      expect(JSON.stringify(logs)).not.toContain(token);
      expect(JSON.stringify(logs)).not.toContain(rows[0].tokenHash);
      expect(JSON.stringify(logs)).not.toContain('9876543210');
    });

    it('reuses the live link for the same template and unchanged bill; a different template replaces it', async () => {
      const billId = await A.bill();
      const first = (await link(A.admin, billId)).json().data;
      const again = (await link(A.admin, billId, A.classic)).json().data;
      expect(again).toMatchObject({ outcome: 'REUSED', url: first.url });
      expect(await state(A.admin, billId)).toMatchObject({ active: true, url: first.url, templateId: A.classic });
      expect(await active(billId)).toHaveLength(1);

      const compact = (await link(A.admin, billId, A.compact)).json().data;
      expect(compact).toMatchObject({ outcome: 'CREATED', templateId: A.compact });
      expect(compact.url).not.toBe(first.url);
      expect((await open(first.url)).statusCode).toBe(404);
      expect((await open(compact.url)).statusCode).toBe(200);
      const rows = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId));
      expect(rows.filter((r) => !r.revokedAt)).toHaveLength(1);
      expect(rows.find((r) => r.revokedAt)!.revokeReason).toBe('REPLACED');
    });

    it.each([
      ['customer name', { customerName: 'Renamed Customer' }],
      ['mobile', { mobileNumber: '9123456780' }],
      ['remark', { remark: 'New remark' }],
      ['quantity', 'qty'],
      ['rate', 'rate'],
      ['discount', { discountType: 'AMOUNT', discountValue: 100 }],
      ['next visit date', { nextVisitDate: '2099-12-31' }],
      ['nothing (an identical re-save)', {}],
    ] as const)('a saved edit of the %s revokes the link at once, and makes no new one', async (_label, change) => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      expect((await open(l.url)).statusCode).toBe(200);
      const body = A.billBody(typeof change === 'string' ? { items: [{ itemId: A.itemId, subItemId: A.subItemId, quantity: change === 'qty' ? 2 : 1, rate: change === 'rate' ? 12000 : 10000 }] } : change);
      const { bookId: _omit, ...update } = body;
      expect((await req(A.admin, 'PUT', `/api/bills/${billId}`, update)).statusCode).toBe(200);

      const gone = await open(l.url);
      expect(gone.statusCode).toBe(404);
      expect(gone.headers['content-type']).toContain('text/html');
      expect(gone.body).toContain('Invoice link no longer valid');
      expect(await active(billId)).toHaveLength(0);
      expect(await state(A.admin, billId)).toMatchObject({ active: false, url: null });
      const [row] = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId));
      expect(row.revokeReason).toBe('BILL_UPDATED');
      const logs = await db.select().from(schema.activityLogs).where(eq(schema.activityLogs.entityId, billId));
      expect(logs.find((x) => x.action === 'invoice_public_link_revoked')!.meta).toMatchObject({ linkId: row.id, reason: 'BILL_UPDATED' });

      // The next share makes a new, working link.
      const next = (await link(A.admin, billId)).json().data;
      expect(next.outcome).toBe('CREATED');
      expect(next.url).not.toBe(l.url);
      expect((await open(next.url)).statusCode).toBe(200);
    });

    it('a refused edit (validation) keeps the link; so do preview, PDF, share context and share-opened', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      const { bookId: _omit, ...bad } = A.billBody({ items: [{ itemId: A.itemId, subItemId: A.subItemId, quantity: 0, rate: 10000 }] });
      expect((await req(A.admin, 'PUT', `/api/bills/${billId}`, bad)).statusCode).toBe(400);
      await req(A.admin, 'GET', `/api/bills/${billId}`);
      await req(A.admin, 'GET', `/api/bills/${billId}/invoice`);
      await req(A.admin, 'GET', `/api/bills/${billId}/invoice/pdf`);
      await req(A.admin, 'GET', `/api/bills/${billId}/invoice/share`);
      await req(A.admin, 'POST', `/api/bills/${billId}/invoice/share-opened`, {});
      expect((await open(l.url)).statusCode).toBe(200);
      expect(await active(billId)).toHaveLength(1);
    });

    it('a Billing READ user may preview and share, but may NOT revoke — and the refused revoke leaves the link intact', async () => {
      const billId = await A.bill();
      expect((await req(A.billingOnly, 'GET', `/api/bills/${billId}/invoice`)).statusCode).toBe(200);
      expect((await req(A.billingOnly, 'GET', `/api/bills/${billId}/invoice/pdf`)).statusCode).toBe(200);
      expect((await req(A.billingOnly, 'GET', `/api/bills/${billId}/invoice/share`)).statusCode).toBe(200);
      const made = await link(A.billingOnly, billId);
      expect(made.statusCode).toBe(200);
      const l = made.json().data;
      expect((await req(A.billingOnly, 'GET', `/api/bills/${billId}/invoice/public-link`)).json().data).toMatchObject({ active: true, url: l.url });
      expect((await req(A.billingOnly, 'POST', `/api/bills/${billId}/invoice/share-opened`, {})).statusCode).toBe(200);

      const before = await active(billId);
      const refused = await req(A.billingOnly, 'DELETE', `/api/bills/${billId}/invoice/public-link`);
      expect(refused.statusCode).toBe(403);
      expect(await active(billId)).toEqual(before);
      expect((await open(l.url)).statusCode).toBe(200);
      const logs = await db.select().from(schema.activityLogs).where(eq(schema.activityLogs.entityId, billId));
      expect(logs.some((x) => x.action === 'invoice_public_link_revoked')).toBe(false);
    });

    it('a Billing UPDATE user can revoke; the URL stops at once and nothing new is made', async () => {
      const billId = await A.bill();
      const l = (await link(A.billingOnly, billId)).json().data;
      const res = await req(A.billingUpdate, 'DELETE', `/api/bills/${billId}/invoice/public-link`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ revoked: true });
      expect((await open(l.url)).statusCode).toBe(404);
      expect(await active(billId)).toHaveLength(0);
      const [row] = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId));
      expect(row.revokeReason).toBe('MANUAL');
      expect((await req(A.billingUpdate, 'DELETE', `/api/bills/${billId}/invoice/public-link`)).json().data).toEqual({ revoked: false });
      // Tenant isolation holds for the revoke too.
      const foreign = await Bt.bill();
      const fl = (await link(Bt.admin, foreign)).json().data;
      expect((await req(A.billingUpdate, 'DELETE', `/api/bills/${foreign}/invoice/public-link`)).statusCode).toBe(404);
      expect((await open(fl.url)).statusCode).toBe(200);
    });

    it('changing PUBLIC_LINK_SECRET invalidates every issued link; the next share makes a working one', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      expect((await open(l.url)).statusCode).toBe(200);
      process.env.PUBLIC_LINK_SECRET = `${SECRET}-rotated`;
      try {
        expect((await open(l.url)).statusCode).toBe(404);
        expect(await state(A.admin, billId)).toMatchObject({ active: false, url: null });
        const next = (await link(A.admin, billId)).json().data;
        expect(next.outcome).toBe('CREATED');
        expect((await open(next.url)).statusCode).toBe(200);
        expect(await active(billId)).toHaveLength(1);
      } finally {
        process.env.PUBLIC_LINK_SECRET = SECRET;
      }
      // Back on the old secret, the rotated-era link is the one that no longer matches.
      expect((await open(l.url)).statusCode).toBe(404);
    });

    it('deleting the bill makes its link unknown', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      expect((await req(A.admin, 'DELETE', `/api/bills/${billId}`)).statusCode).toBe(200);
      expect((await open(l.url)).statusCode).toBe(404);
    });
  });

  describe('defence in depth', () => {
    it('a link whose bill revision moved (revoke bypassed) is refused, and revoked on sight', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      await db.update(schema.bills).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.bills.id, billId));
      expect((await open(l.url)).statusCode).toBe(404);
      const [row] = await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId));
      expect(row.revokeReason).toBe('STALE');
    });

    it('unknown, malformed and revoked tokens all get the identical response', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      await req(A.admin, 'DELETE', `/api/bills/${billId}/invoice/public-link`);
      const revoked = await open(l.url);
      const unknown = await open(`${BASE}/i/${tokenFor(SECRET, randomUUID())}`);
      const malformed = await open(`${BASE}/i/123`);
      for (const r of [unknown, malformed]) {
        expect(r.statusCode).toBe(revoked.statusCode);
        expect(r.body).toBe(revoked.body);
      }
    });

    it('a template made unusable behind the service’s back gives a calm "not available" page, never internals', async () => {
      const billId = await A.bill();
      const [t] = await db.insert(schema.invoiceTemplates).values({ tenantId: A.tenantId, templateName: `Tmp ${Math.random()}`, supportedMode: 'BOTH', layoutPreset: 'CLASSIC', config: starters[0].config }).returning();
      const l = (await link(A.admin, billId, t.id)).json().data;
      await db.update(schema.invoiceTemplates).set({ supportedMode: 'WITHOUT_GST' }).where(eq(schema.invoiceTemplates.id, t.id));
      const res = await open(l.url);
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Invoice not available right now');
      expect(res.body).not.toMatch(/WITHOUT_GST|template|tenant|stack/i);
    });

    it('renders are rate-limited per LINK (30/min), not per client; other links are unaffected', async () => {
      const billId = await A.bill();
      const other = await A.bill();
      const l = (await link(A.admin, billId)).json().data;
      const o = (await link(A.admin, other)).json().data;
      const codes: number[] = [];
      for (let i = 0; i < 31; i++) codes.push((await open(l.url)).statusCode);
      expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
      expect(codes[30]).toBe(429);
      expect((await open(o.url)).statusCode).toBe(200);
    });

    it('text the PDF cannot print is refused before any link exists', async () => {
      const billId = await A.bill({ customerName: 'தமிழ் Customer' });
      const res = await link(A.admin, billId);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVOICE_UNPRINTABLE_TEXT');
      expect(await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, billId))).toHaveLength(0);
    });

    it('the database itself refuses a second active link for one bill', async () => {
      const billId = await A.bill();
      await link(A.admin, billId);
      await expect(
        db.insert(schema.publicInvoiceLinks).values({ tenantId: A.tenantId, billId, templateId: A.classic, tokenHash: hashToken(randomUUID()), billRevision: new Date() }),
      ).rejects.toThrow();
    });
  });

  describe('templates', () => {
    it('editing, deactivating or deleting the link’s template revokes it; other bills’ links on other templates survive', async () => {
      const mk = async () => (await db.insert(schema.invoiceTemplates).values({ tenantId: A.tenantId, templateName: `Edit ${Math.random()}`, supportedMode: 'BOTH', layoutPreset: 'CLASSIC', config: starters[0].config }).returning())[0];
      const body = (t: { templateName: string }, over: Record<string, unknown> = {}) => ({ templateName: t.templateName, supportedMode: 'BOTH', layoutPreset: 'CLASSIC', config: starters[0].config, isActive: true, ...over });

      const other = await A.bill();
      const otherLink = (await link(A.admin, other, A.classic)).json().data;

      for (const action of ['edit', 'deactivate', 'delete'] as const) {
        const t = await mk();
        const billId = await A.bill();
        const l = (await link(A.admin, billId, t.id)).json().data;
        expect((await open(l.url)).statusCode).toBe(200);
        const res =
          action === 'delete'
            ? await req(A.admin, 'DELETE', `/api/settings/invoice-templates/${t.id}`)
            : await req(A.admin, 'PUT', `/api/settings/invoice-templates/${t.id}`, body(t, action === 'deactivate' ? { isActive: false } : { description: 'changed' }));
        expect(res.statusCode).toBe(200);
        expect((await open(l.url)).statusCode).toBe(404);
        expect(await active(billId)).toHaveLength(0);
        const log = (await db.select().from(schema.activityLogs).where(eq(schema.activityLogs.entityId, t.id))).find((x) => x.action === 'invoice_public_link_revoked');
        expect(log?.meta).toMatchObject({ reason: 'TEMPLATE_CHANGED' });
      }
      expect((await open(otherLink.url)).statusCode).toBe(200);
    });

    it('setting another default does not touch a live link', async () => {
      const billId = await A.bill();
      const l = (await link(A.admin, billId, A.classic)).json().data;
      await req(A.admin, 'POST', `/api/settings/invoice-templates/${A.compact}/default`);
      expect((await open(l.url)).statusCode).toBe(200);
      await req(A.admin, 'POST', `/api/settings/invoice-templates/${A.classic}/default`);
    });
  });

  describe('authorization and tenant isolation', () => {
    it('link endpoints need a session and operations_billing, and stay inside the tenant', async () => {
      const billId = await A.bill();
      const foreign = await Bt.bill();
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        expect((await app.inject({ method, url: `/api/bills/${billId}/invoice/public-link` })).statusCode).toBe(401);
        expect((await req(A.templatesRead, method, `/api/bills/${billId}/invoice/public-link`)).statusCode).toBe(403);
        expect((await req(A.admin, method, `/api/bills/${foreign}/invoice/public-link`)).statusCode).toBe(404);
      }
      // Another tenant's template cannot be used for this tenant's link.
      const bTemplate = (await req(Bt.admin, 'GET', '/api/settings/invoice-templates')).json().data.rows[0].id;
      expect((await link(A.admin, billId, bTemplate)).statusCode).toBe(404);
      expect(await db.select().from(schema.publicInvoiceLinks).where(eq(schema.publicInvoiceLinks.billId, foreign))).toHaveLength(0);
    });

    it('a token opens exactly its own invoice — tenant B’s link gives B’s PDF, byte for byte', async () => {
      const aBill = await A.bill({ customerName: 'Alpha' });
      const bBill = await Bt.bill({ customerName: 'Bravo' });
      const aLink = (await link(A.admin, aBill)).json().data;
      const bLink = (await link(Bt.admin, bBill)).json().data;
      const bPdf = (await req(Bt.admin, 'GET', `/api/bills/${bBill}/invoice/pdf`)).rawPayload;
      const aPdf = (await req(A.admin, 'GET', `/api/bills/${aBill}/invoice/pdf`)).rawPayload;
      expect(Buffer.compare((await open(bLink.url)).rawPayload, bPdf)).toBe(0);
      expect(Buffer.compare((await open(aLink.url)).rawPayload, aPdf)).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('simultaneous shares of one bill end with ONE live link, and they all got it', async () => {
      const billId = await A.bill();
      const results = await Promise.all(Array.from({ length: 12 }, () => link(A.admin, billId)));
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      const urls = new Set(results.map((r) => r.json().data.url));
      expect(urls.size).toBe(1);
      expect(results.filter((r) => r.json().data.outcome === 'CREATED')).toHaveLength(1);
      expect(await active(billId)).toHaveLength(1);
    });

    it('simultaneous shares with different templates still leave exactly one live link, and it works', async () => {
      const billId = await A.bill();
      await Promise.all(Array.from({ length: 10 }, (_, i) => link(A.admin, billId, i % 2 ? A.compact : A.classic)));
      expect(await active(billId)).toHaveLength(1);
      const s = await state(A.admin, billId);
      expect((await open(s.url)).statusCode).toBe(200);
    });

    it('a share racing a bill edit never leaves a link for an old revision alive', async () => {
      const billId = await A.bill();
      const handed: string[] = [];
      for (let i = 0; i < 8; i++) {
        const { bookId: _omit, ...update } = A.billBody({ remark: `race ${i}` });
        const [, shared] = await Promise.all([req(A.admin, 'PUT', `/api/bills/${billId}`, update), link(A.admin, billId)]);
        if (shared.statusCode === 200) handed.push(shared.json().data.url);
      }
      const live = await active(billId);
      expect(live.length).toBeLessThanOrEqual(1);
      const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.id, billId));
      if (live[0]) expect(live[0].billRevision.getTime()).toBe(bill.updatedAt.getTime());
      // Every URL handed out either opens the CURRENT bill or is refused.
      const current = live[0] ? (await state(A.admin, billId)).url : null;
      for (const u of new Set(handed)) expect((await open(u)).statusCode).toBe(u === current ? 200 : 404);
    });
  });

  it('link operations never change a bill figure, a line, a book counter or the appointment counter', async () => {
    const billId = await A.bill({ discountType: 'PERCENT', discountValue: 10 });
    const snap = async () =>
      JSON.stringify([
        await db.select().from(schema.bills).where(eq(schema.bills.id, billId)),
        await db.select().from(schema.billItems).where(eq(schema.billItems.billId, billId)),
        await db.select({ n: schema.books.nextBillNumber }).from(schema.books).where(eq(schema.books.id, A.bookId)),
        await db.select().from(schema.documentCounters).where(eq(schema.documentCounters.tenantId, A.tenantId)),
      ]);
    const before = await snap();
    const l = (await link(A.admin, billId)).json().data;
    await link(A.admin, billId);
    await state(A.admin, billId);
    await open(l.url);
    await link(A.admin, billId, A.compact);
    await req(A.admin, 'DELETE', `/api/bills/${billId}/invoice/public-link`);
    await open(l.url);
    expect(await snap()).toBe(before);
  });

  async function billNumber(billId: string) {
    const [b] = await db.select({ n: schema.bills.billNumber }).from(schema.bills).where(eq(schema.bills.id, billId));
    return b.n;
  }
});
