import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  DATE_FORMATS,
  appSettingsSchema,
  appointmentSchema,
  billSchema,
  dateFormatLabel,
  formatClockTime,
  formatDateOnly,
  formatTimestamp,
  isIsoDate,
  parseDisplayDate,
  toDateFormat,
  toTimeFormat,
} from '@erp/shared';
import { sniffLogoType } from '../services/company';

/**
 * Settings — the display date format, the company profile that brands the app, and the
 * company logo.
 *
 * Section A is pure — the shared date rules every screen formats with, the settings payload
 * rule and the logo type check. Always runs. Section B needs a database and is skipped unless
 * TEST_DATABASE_URL is set: tenant isolation of settings / profile / logo, and who may change
 * them.
 */

const DAY = '2026-09-25';

/* ----------------------------------------------- A. display date rules --- */

describe('formatDateOnly — a business date in the tenant’s order', () => {
  it.each([
    ['dd/MM/yyyy', '25/09/2026'],
    ['dd-MM-yyyy', '25-09-2026'],
    ['MM/dd/yyyy', '09/25/2026'],
    ['yyyy-MM-dd', '2026-09-25'],
  ] as const)('%s shows 2026-09-25 as %s', (format, shown) => {
    expect(formatDateOnly(DAY, format)).toBe(shown);
  });

  it('changing the setting changes the output, and only the output', () => {
    const outputs = DATE_FORMATS.map((f) => formatDateOnly(DAY, f));
    expect(new Set(outputs).size).toBe(DATE_FORMATS.length);
    for (const f of DATE_FORMATS) expect(parseDisplayDate(formatDateOnly(DAY, f), f)).toBe(DAY);
  });

  it.each([null, undefined, ''])('shows %p as "-"', (v) => {
    expect(formatDateOnly(v, 'dd/MM/yyyy')).toBe('-');
  });

  /** Bad data stays visible as itself instead of becoming a plausible wrong date. */
  it.each(['2026-02-30', '2026-13-01', '25/09/2026', 'not a date', '2026-09-25T00:00:00.000Z'])('returns %p untouched, because it is not a real YYYY-MM-DD', (v) => {
    expect(formatDateOnly(v, 'dd/MM/yyyy')).toBe(v);
  });

  it('handles a leap day, and refuses one in a common year', () => {
    expect(formatDateOnly('2028-02-29', 'dd/MM/yyyy')).toBe('29/02/2028');
    expect(formatDateOnly('2026-02-29', 'dd/MM/yyyy')).toBe('2026-02-29');
    expect(isIsoDate('2000-02-29')).toBe(true);
    expect(isIsoDate('1900-02-29')).toBe(false);
  });

  /**
   * The bug this protects against: `new Date('2026-09-25')` is UTC midnight, which in any
   * timezone behind UTC is still the 24th. The formatter must not care what zone it runs in.
   */
  describe('no timezone shift', () => {
    const original = process.env.TZ;
    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it.each(['America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Kolkata', 'Pacific/Kiritimati'])('keeps 25 September as the 25th in %s', (tz) => {
      process.env.TZ = tz;
      expect(formatDateOnly(DAY, 'dd/MM/yyyy')).toBe('25/09/2026');
      expect(parseDisplayDate('25/09/2026', 'dd/MM/yyyy')).toBe(DAY);
    });

    it('is exactly the trap a Date round-trip falls into', () => {
      process.env.TZ = 'America/Los_Angeles';
      expect(new Date(DAY).getDate()).toBe(24); // the naive way shifts the day
      expect(formatDateOnly(DAY, 'dd/MM/yyyy')).toBe('25/09/2026'); // ours does not
    });
  });

  /** Every business date field goes through the same rule — there is no per-module formatter. */
  it.each([
    ['Appointment Date', '2026-09-25', '25/09/2026'],
    ['Bill Date', '2026-04-01', '01/04/2026'],
    ['Delivery Date', '2026-12-31', '31/12/2026'],
    ['Birth Date', '2024-02-29', '29/02/2024'],
  ])('%s %s shows as %s under DD/MM/YYYY', (_field, stored, shown) => {
    expect(formatDateOnly(stored, 'dd/MM/yyyy')).toBe(shown);
  });
});

describe('storage stays canonical whatever the display format', () => {
  it('the bill schema accepts only YYYY-MM-DD for its dates', () => {
    const base = { bookId: '00000000-0000-4000-8000-000000000001', customerName: 'R', mobileNumber: '9876543210', items: [{ itemId: '00000000-0000-4000-8000-000000000002', subItemId: '00000000-0000-4000-8000-000000000003', quantity: 1, rate: 100 }] };
    expect(billSchema.safeParse({ ...base, billDate: DAY }).success).toBe(true);
    expect(billSchema.safeParse({ ...base, billDate: '25/09/2026' }).success).toBe(false);
    expect(billSchema.safeParse({ ...base, billDate: DAY, deliveryDate: '25-09-2026' }).success).toBe(false);
    expect(billSchema.safeParse({ ...base, billDate: DAY, hasBirthDate: true, birthDate: '09/25/2026' }).success).toBe(false);
  });

  it('the appointment schema accepts only YYYY-MM-DD', () => {
    const base = { customerName: 'R', mobileNumber: '9876543210' };
    expect(appointmentSchema.safeParse({ ...base, appointmentDate: DAY }).success).toBe(true);
    expect(appointmentSchema.safeParse({ ...base, appointmentDate: '25/09/2026' }).success).toBe(false);
  });
});

describe('parseDisplayDate — what the operator typed, back to YYYY-MM-DD', () => {
  it.each([
    ['25/09/2026', 'dd/MM/yyyy', DAY],
    ['25-09-2026', 'dd-MM-yyyy', DAY],
    ['25.09.2026', 'dd/MM/yyyy', DAY],
    ['25-09-2026', 'dd/MM/yyyy', DAY],
    ['5/9/2026', 'dd/MM/yyyy', '2026-09-05'],
    [' 25/09/2026 ', 'dd/MM/yyyy', DAY],
    ['09/25/2026', 'MM/dd/yyyy', DAY],
    ['2026-09-25', 'yyyy-MM-dd', DAY],
    ['2026-09-25', 'dd/MM/yyyy', DAY], // a pasted ISO date always works
    ['29/02/2028', 'dd/MM/yyyy', '2028-02-29'],
  ] as const)('reads %p under %s as %s', (text, format, iso) => {
    expect(parseDisplayDate(text, format)).toBe(iso);
  });

  it.each([
    ['25/09/2026', 'MM/dd/yyyy'], // month 25
    ['31/04/2026', 'dd/MM/yyyy'], // April has 30 days
    ['29/02/2026', 'dd/MM/yyyy'], // not a leap year
    ['25/09/26', 'dd/MM/yyyy'], // two-digit year is ambiguous
    ['25/09', 'dd/MM/yyyy'],
    ['25/09/2026/1', 'dd/MM/yyyy'],
    ['abc', 'dd/MM/yyyy'],
    ['', 'dd/MM/yyyy'],
    ['25/09/2026', 'yyyy-MM-dd'],
  ] as const)('refuses %p under %s', (text, format) => {
    expect(parseDisplayDate(text, format)).toBeNull();
  });
});

describe('formatTimestamp — Created At / Last Modified', () => {
  // Built from local parts at call time, so the expectation holds in whatever zone the suite runs.
  const at = () => new Date(2026, 8, 25, 10, 42);

  it('uses the tenant’s date order, never the browser locale', () => {
    expect(formatTimestamp(at(), { dateFormat: 'dd/MM/yyyy' })).toBe('25/09/2026');
    expect(formatTimestamp(at(), { dateFormat: 'dd-MM-yyyy' })).toBe('25-09-2026');
    expect(formatTimestamp(at(), { dateFormat: 'MM/dd/yyyy' })).toBe('09/25/2026');
  });

  it('keeps the time where the screen shows it', () => {
    expect(formatTimestamp(at(), { dateFormat: 'dd/MM/yyyy', withTime: true })).toBe('25/09/2026 10:42 AM');
    expect(formatTimestamp(at(), { dateFormat: 'dd/MM/yyyy', timeFormat: 'HH:mm', withTime: true })).toBe('25/09/2026 10:42');
    expect(formatTimestamp(new Date(2026, 8, 25, 0, 5), { dateFormat: 'dd/MM/yyyy', withTime: true })).toBe('25/09/2026 12:05 AM');
  });

  it('accepts an ISO string as the API sends it', () => {
    expect(formatTimestamp(at().toISOString(), { dateFormat: 'dd/MM/yyyy' })).toBe('25/09/2026');
  });

  it.each([null, undefined, ''])('shows %p as "-"', (v) => {
    expect(formatTimestamp(v)).toBe('-');
  });

  it('returns an unparseable value untouched', () => {
    expect(formatTimestamp('garbage')).toBe('garbage');
  });
});

describe('formatClockTime — Appointment time, unchanged behaviour', () => {
  it.each([
    ['14:30:00', 'hh:mm tt', '02:30 PM'],
    ['09:05', 'hh:mm tt', '09:05 AM'],
    ['00:00', 'hh:mm tt', '12:00 AM'],
    ['12:00', 'hh:mm tt', '12:00 PM'],
    ['14:30:00', 'HH:mm', '14:30'],
  ] as const)('%s under %s is %s', (t, f, shown) => {
    expect(formatClockTime(t, f)).toBe(shown);
  });

  it('shows a missing time as "-"', () => {
    expect(formatClockTime(null)).toBe('-');
  });
});

describe('stored format values', () => {
  it('fall back to the defaults when unknown, so a bad stored value cannot break every screen', () => {
    expect(toDateFormat('DD/MM/YYYY')).toBe('dd-MM-yyyy');
    expect(toDateFormat(undefined)).toBe('dd-MM-yyyy');
    expect(toDateFormat('dd/MM/yyyy')).toBe('dd/MM/yyyy');
    expect(toTimeFormat('whatever')).toBe('hh:mm tt');
  });

  it('label as the operator reads them', () => {
    expect(dateFormatLabel('dd/MM/yyyy')).toBe('DD/MM/YYYY');
  });
});

describe('appSettingsSchema (PUT /api/settings)', () => {
  it.each(DATE_FORMATS)('accepts date format %s', (f) => {
    expect(appSettingsSchema.parse({ dateFormat: f })).toEqual({ dateFormat: f });
  });

  it.each(['DD/MM/YYYY', 'dd.MM.yyyy', '', 5])('refuses date format %p', (f) => {
    expect(appSettingsSchema.safeParse({ dateFormat: f }).success).toBe(false);
  });

  it('refuses an unknown time format', () => {
    expect(appSettingsSchema.safeParse({ timeFormat: 'h:mm' }).success).toBe(false);
  });

  it('passes the other settings keys through untouched', () => {
    expect(appSettingsSchema.parse({ sessionHours: 8, themeMode: 'dark' })).toEqual({ sessionHours: 8, themeMode: 'dark' });
  });
});

/* ------------------------------------------------- logo type check ------ */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('sniffLogoType — the file’s own bytes decide, not its name or declared type', () => {
  it('recognises PNG, JPEG and WebP', () => {
    expect(sniffLogoType(PNG_1PX)).toBe('image/png');
    expect(sniffLogoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image/jpeg');
    expect(sniffLogoType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
  });

  it.each([
    ['an SVG, which can carry script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['a GIF', Buffer.from('GIF89a')],
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['an empty file', Buffer.alloc(0)],
    ['a truncated PNG header', PNG_1PX.subarray(0, 4)],
  ])('refuses %s', (_label, buf) => {
    expect(sniffLogoType(buf)).toBeNull();
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Point it at a THROWAWAY database only. It creates and deletes tenants, companies, roles and
 * users, and must never run against the shared hosted DATABASE_URL in apps/api/.env.
 *
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Settings, company profile and logo API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;

  const tenantIds: string[] = [];
  const A = { token: '', readOnly: '', noSettings: '', companyId: '' };
  const B = { token: '', companyId: '' };

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });
  const profile = async (token: string) => (await get(token, '/api/settings/company')).json().data;

  function multipart(file: Buffer, filename = 'logo.png', type = 'image/png') {
    const boundary = `----studiocrm${Math.random().toString(36).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }
  const putLogo = (token: string, companyId: string, file: Buffer, filename?: string, type?: string) => {
    const m = multipart(file, filename, type);
    return app.inject({ method: 'PUT', url: `/api/admin/companies/${companyId}/logo`, headers: { ...auth(token), ...m.headers }, payload: m.payload });
  };

  /** A tenant bootstrapped like a real one (default company, settings), plus users with the given grants. */
  async function seedTenant(name: string, users: Record<string, Record<string, string[]>>) {
    const { seedTenantDefaults } = await import('../services/tenant-setup');
    const [tenant] = await db.insert(schema.tenants).values({ name: `${name} tenant`, slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    tenantIds.push(tenant.id);
    const { company } = await seedTenantDefaults(db, tenant.id, { companyName: `${name} Studio` });
    const tokens: Record<string, string> = {};
    for (const [key, grants] of Object.entries(users)) {
      const [role] = await db.insert(schema.roles).values({ tenantId: tenant.id, name: `${name} ${key}`, permissions: grants }).returning();
      const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, roleId: role.id, firstName: name, lastName: key, email: `${name}-${key}-${Date.now()}@test.local`, passwordHash: 'not-a-real-hash' }).returning();
      tokens[key] = app.jwt.sign({ sub: user.id, tenantId: tenant.id });
    }
    return { companyId: company.id, tokens };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    inArray = (await import('drizzle-orm')).inArray;
    const client = await import('../db/client');
    db = client.db;
    sqlClient = client.sql;
    schema = client.schema;
    app = await (await import('../server')).buildApp();
    await app.ready();

    const admin = { admin_companies: ['read', 'create', 'update', 'delete'], settings_general: ['read', 'update'] };
    const a = await seedTenant('st-a', { admin, readOnly: { admin_companies: ['read'], settings_general: ['read'] }, noSettings: {} });
    Object.assign(A, { companyId: a.companyId, token: a.tokens.admin, readOnly: a.tokens.readOnly, noSettings: a.tokens.noSettings });
    const b = await seedTenant('st-b', { admin });
    Object.assign(B, { companyId: b.companyId, token: b.tokens.admin });
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(schema.companyLogos).where(inArray(schema.companyLogos.tenantId, tenantIds));
      await db.delete(schema.branches).where(inArray(schema.branches.tenantId, tenantIds));
      await db.delete(schema.companies).where(inArray(schema.companies.tenantId, tenantIds));
      await db.delete(schema.appSettings).where(inArray(schema.appSettings.tenantId, tenantIds));
      await db.delete(schema.activityLogs).where(inArray(schema.activityLogs.tenantId, tenantIds));
      await db.delete(schema.users).where(inArray(schema.users.tenantId, tenantIds));
      await db.delete(schema.roles).where(inArray(schema.roles.tenantId, tenantIds));
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('company profile', () => {
    it('returns the caller’s own default company, never another tenant’s', async () => {
      expect(await profile(A.token)).toMatchObject({ id: A.companyId, name: 'st-a Studio', logo: null });
      expect(await profile(B.token)).toMatchObject({ id: B.companyId, name: 'st-b Studio' });
    });

    it('is readable by any signed-in user, because every screen’s sidebar needs it', async () => {
      expect((await get(A.noSettings, '/api/settings/company')).statusCode).toBe(200);
    });

    it('requires a session', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/settings/company' })).statusCode).toBe(401);
    });

    it('follows a rename of the company, and the other tenant does not see it', async () => {
      const row = (await get(A.token, `/api/admin/companies/${A.companyId}`)).json().data;
      const res = await app.inject({ method: 'PUT', url: `/api/admin/companies/${A.companyId}`, headers: auth(A.token), payload: { ...row, name: 'Pratishtha Studio' } });
      expect(res.statusCode).toBe(200);
      expect((await profile(A.token)).name).toBe('Pratishtha Studio');
      expect((await profile(B.token)).name).toBe('st-b Studio');
    });

    it('carries no settings the client could use to pick another company', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/settings/company?companyId=${B.companyId}&tenantId=x`, headers: auth(A.token) });
      expect(res.json().data.id).toBe(A.companyId);
    });
  });

  describe('company logo', () => {
    it('is uploaded, versioned into the profile and served back byte for byte', async () => {
      const res = await putLogo(A.token, A.companyId, PNG_1PX);
      expect(res.statusCode).toBe(200);
      const version = res.json().data.version as string;
      expect((await profile(A.token)).logo).toEqual({ version, contentType: 'image/png' });

      const img = await get(A.readOnly, `/api/admin/companies/${A.companyId}/logo?v=${version}`);
      expect(img.statusCode).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(img.rawPayload.equals(PNG_1PX)).toBe(true);
    });

    it('gets a new version when replaced, so the browser never shows the old one', async () => {
      const first = (await putLogo(A.token, A.companyId, PNG_1PX)).json().data.version;
      await new Promise((r) => setTimeout(r, 5));
      const second = (await putLogo(A.token, A.companyId, PNG_1PX)).json().data.version;
      expect(second).not.toBe(first);
    });

    it('is not readable across tenants', async () => {
      await putLogo(A.token, A.companyId, PNG_1PX);
      expect((await get(B.token, `/api/admin/companies/${A.companyId}/logo`)).statusCode).toBe(404);
    });

    it('cannot be set on another tenant’s company', async () => {
      expect((await putLogo(B.token, A.companyId, PNG_1PX)).statusCode).toBe(404);
    });

    it('needs admin_companies update to change', async () => {
      expect((await putLogo(A.readOnly, A.companyId, PNG_1PX)).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/api/admin/companies/${A.companyId}/logo`, headers: auth(A.readOnly) })).statusCode).toBe(403);
    });

    it('refuses a file that is not really an image, whatever it claims to be', async () => {
      const res = await putLogo(A.token, A.companyId, Buffer.from('<svg><script>alert(1)</script></svg>'), 'logo.png', 'image/png');
      expect(res.statusCode).toBe(400);
    });

    /**
     * Regression: the multipart reader truncates an oversized file instead of always throwing,
     * so a 1 MB + N upload used to arrive cut to exactly 1 MB and be stored as a broken image.
     */
    it('refuses a file over 1 MB rather than storing it truncated', async () => {
      const big = Buffer.concat([PNG_1PX, Buffer.alloc(1024 * 1024)]);
      expect((await putLogo(A.token, A.companyId, big)).statusCode).toBe(400);
      expect((await putLogo(A.token, A.companyId, Buffer.concat([PNG_1PX, Buffer.alloc(1024 * 1024 - PNG_1PX.length + 1)]))).statusCode).toBe(400);
    });

    it('accepts a file of exactly 1 MB', async () => {
      const exact = Buffer.concat([PNG_1PX, Buffer.alloc(1024 * 1024 - PNG_1PX.length)]);
      expect((await putLogo(A.token, A.companyId, exact)).statusCode).toBe(200);
    });

    it('answers a malformed company id with 404, not a database error', async () => {
      expect((await get(A.token, '/api/admin/companies/not-a-uuid/logo')).statusCode).toBe(404);
    });

    it('is removed, and the profile then reports no logo (the shell falls back to initials)', async () => {
      await putLogo(A.token, A.companyId, PNG_1PX);
      expect((await app.inject({ method: 'DELETE', url: `/api/admin/companies/${A.companyId}/logo`, headers: auth(A.token) })).statusCode).toBe(200);
      expect((await profile(A.token)).logo).toBeNull();
      expect((await get(A.token, `/api/admin/companies/${A.companyId}/logo`)).statusCode).toBe(404);
    });
  });

  describe('application settings', () => {
    const put = (token: string, body: object) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth(token), payload: body });

    it('stores the date format per tenant', async () => {
      expect((await put(A.token, { dateFormat: 'dd/MM/yyyy' })).statusCode).toBe(200);
      expect((await put(B.token, { dateFormat: 'MM/dd/yyyy' })).statusCode).toBe(200);
      expect((await get(A.token, '/api/settings')).json().data.dateFormat).toBe('dd/MM/yyyy');
      expect((await get(B.token, '/api/settings')).json().data.dateFormat).toBe('MM/dd/yyyy');
    });

    it('refuses a format the app cannot render', async () => {
      expect((await put(A.token, { dateFormat: 'DD/MM/YYYY' })).statusCode).toBe(400);
      expect((await get(A.token, '/api/settings')).json().data.dateFormat).toBe('dd/MM/yyyy');
    });

    it('needs settings_general update to change', async () => {
      expect((await put(A.readOnly, { dateFormat: 'yyyy-MM-dd' })).statusCode).toBe(403);
      expect((await put(A.noSettings, { dateFormat: 'yyyy-MM-dd' })).statusCode).toBe(403);
    });

    it('is readable by every signed-in user, because every screen formats dates', async () => {
      expect((await get(A.noSettings, '/api/settings')).statusCode).toBe(200);
    });
  });
});
