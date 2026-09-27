import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_PRINT_SETTINGS,
  INVOICE_ACCENT_COLORS,
  amountInWords,
  buildInvoiceModel,
  invoiceTemplateConfigSchema,
  invoiceTemplateSchema,
  legacyStudioTemplate,
  pickInvoiceTemplate,
  printSettingsSchema,
  sampleInvoiceBill,
  starterInvoiceTemplates,
  toPrintSettings,
  type CompanyProfile,
  type InvoiceBillSource,
  type InvoiceTemplateSource,
  type PrintSettings,
} from '@erp/shared';
import { renderInvoicePdf } from '../services/invoicePdf';

/**
 * Print & Invoice settings and the "Legacy Studio" template (docs/INVOICE_TEMPLATES.md).
 *
 * Section A is pure and always runs: amount in words, the settings schema, what the render model
 * takes from the settings (copy label, accent, bank, terms, images, payments), the Studio style,
 * A5, and real PDFs parsed back. Section B needs TEST_DATABASE_URL (a THROWAWAY database): saving
 * and reading the settings, RBAC and tenant isolation, the print images, Legacy Studio seeding,
 * Advance / Received on a real bill, the public link, and that nothing here changes a bill.
 */

const legacy = (): InvoiceTemplateSource => ({ id: 'tpl-legacy', ...structuredClone(legacyStudioTemplate()) });
const classic = (): InvoiceTemplateSource => ({ id: 'tpl-classic', ...structuredClone(starterInvoiceTemplates()[0]) });
const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-00000000c0de', name: 'Sunrise Photo Studio', legalName: null, taxId: '24ABCDE1234F1Z5', email: null, phone: '98250 12345', website: null,
  addressLine1: '12, Station Road', addressLine2: null, city: 'Rajkot', state: 'Gujarat', pincode: '360001', countryCode: 'IN', currency: 'INR',
  logo: { version: '1', contentType: 'image/png' }, signature: { version: '2', contentType: 'image/png' }, footerImage: { version: '3', contentType: 'image/png' },
};
const print = (over: Partial<PrintSettings> = {}): PrintSettings => ({ ...structuredClone(DEFAULT_PRINT_SETTINGS), ...over });
const bank = { bankName: 'State Bank of India', accountName: 'Sunrise Photo Studio', accountNumber: '12345678901', ifsc: 'SBIN0001234', branch: 'Station Road' };
const model = (o: { bill?: InvoiceBillSource; template?: InvoiceTemplateSource; print?: PrintSettings; payments?: { paid: number; outstanding: number } | null; copy?: 'NONE' | 'ORIGINAL' | 'DUPLICATE' | 'OFFICE_COPY'; company?: CompanyProfile | null } = {}) =>
  buildInvoiceModel({ bill: o.bill ?? sampleInvoiceBill('WITH_GST'), company: o.company === undefined ? company : o.company, dateFormat: 'dd/MM/yyyy', template: o.template ?? legacy(), print: o.print, payments: o.payments, copyLabel: o.copy });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGPgUv/PwMDAAAAIjAFR9P6TeAAAAABJRU5ErkJggg==', 'base64');
const img = { data: new Uint8Array(PNG), contentType: 'image/png' };
async function pdfPages(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true }).promise;
  const pages: { text: string; width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const [, , w, h] = page.view;
    pages.push({ text: tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' '), width: w, height: h });
  }
  return pages;
}
const imageCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length;

/* ======================================================= A — pure ===== */

describe('amount in words (Indian system, from the stored Grand Total)', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [0.5, 'Fifty Paise Only'],
    [1, 'Rupees One Only'],
    [19, 'Rupees Nineteen Only'],
    [105, 'Rupees One Hundred Five Only'],
    [12550.5, 'Rupees Twelve Thousand Five Hundred Fifty and Fifty Paise Only'],
    [100000, 'Rupees One Lakh Only'],
    [1234567.89, 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only'],
    [10000000, 'Rupees One Crore Only'],
    [1000000000, 'Rupees One Hundred Crore Only'],
    [65625, 'Rupees Sixty Five Thousand Six Hundred Twenty Five Only'],
  ])('%s -> %s', (value, words) => expect(amountInWords(value)).toBe(words));

  it('works on paise like formatAmount — a float never adds a stray paisa', () => {
    expect(amountInWords(0.1 + 0.2)).toBe('Thirty Paise Only');
    expect(amountInWords(1234.005)).toBe('Rupees One Thousand Two Hundred Thirty Four and One Paise Only');
  });
});

describe('Print & Invoice settings schema', () => {
  it('accepts the defaults and a full, realistic set; IFSC is upper-cased', () => {
    expect(printSettingsSchema.parse(DEFAULT_PRINT_SETTINGS)).toEqual(DEFAULT_PRINT_SETTINGS);
    const p = printSettingsSchema.parse(print({ bank: { ...bank, ifsc: 'sbin0001234' }, accent: 'TEAL', copyLabel: 'DUPLICATE', defaultDeliveryDays: 3, terms: 'Line 1\nLine 2' }));
    expect(p.bank.ifsc).toBe('SBIN0001234');
    expect(p.defaultDeliveryDays).toBe(3);
  });

  it.each([
    ['an unknown key', { ...DEFAULT_PRINT_SETTINGS, printer: 'HP' }],
    ['an unknown accent', { ...DEFAULT_PRINT_SETTINGS, accent: 'NEON' }],
    ['an unknown copy label', { ...DEFAULT_PRINT_SETTINGS, copyLabel: 'TRIPLICATE' }],
    ['negative delivery days', { ...DEFAULT_PRINT_SETTINGS, defaultDeliveryDays: -1 }],
    ['fractional delivery days', { ...DEFAULT_PRINT_SETTINGS, defaultDeliveryDays: 2.5 }],
    ['over-long terms', { ...DEFAULT_PRINT_SETTINGS, terms: 'x'.repeat(1001) }],
    ['a two-line account number', { ...DEFAULT_PRINT_SETTINGS, bank: { ...bank, accountNumber: '123\n456' } }],
    ['control characters', { ...DEFAULT_PRINT_SETTINGS, footerText: 'bad\u0007' }],
  ])('refuses %s', (_why, body) => expect(printSettingsSchema.safeParse(body).success).toBe(false));

  it('toPrintSettings fills missing keys and falls back FIELD BY FIELD — one bad value never wipes the rest', () => {
    expect(toPrintSettings(undefined)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(toPrintSettings({ accent: 'BLUE' }).accent).toBe('BLUE');
    expect(toPrintSettings({ bank: { ifsc: 'X' } }).bank).toEqual({ ...DEFAULT_PRINT_SETTINGS.bank, ifsc: 'X' });
    expect(toPrintSettings({ accent: 'NEON' })).toEqual(DEFAULT_PRINT_SETTINGS);
    const kept = toPrintSettings({ accent: 'NEON', terms: 'Keep me', printer: 'HP', bank: { bankName: 'Keep bank', accountNumber: 'a\nb' } });
    expect(kept.accent).toBe('NEUTRAL');
    expect(kept.terms).toBe('Keep me');
    expect(kept.bank).toEqual({ ...DEFAULT_PRINT_SETTINGS.bank, bankName: 'Keep bank' });
    expect(kept).not.toHaveProperty('printer');
  });
});

describe('templates stay compatible', () => {
  it('a config stored before these settings (no new keys) still parses, with the new options off', () => {
    const old = structuredClone(starterInvoiceTemplates()[0].config) as Record<string, any>;
    delete old.totals.showAmountInWords;
    delete old.totals.showPayments;
    delete old.footer.showReceivedBy;
    const parsed = invoiceTemplateConfigSchema.parse(old);
    expect(parsed.totals.showAmountInWords).toBe(false);
    expect(parsed.totals.showPayments).toBe(false);
    expect(parsed.footer.showReceivedBy).toBe(false);
  });

  it('Legacy Studio is a valid BOTH template on the Studio preset, never the default', () => {
    const t = legacyStudioTemplate();
    expect(invoiceTemplateSchema.safeParse(t).success).toBe(true);
    expect(t).toMatchObject({ templateName: 'Legacy Studio', supportedMode: 'BOTH', layoutPreset: 'STUDIO', isDefault: false });
    const starters = starterInvoiceTemplates();
    expect(starters[0].templateName).toBe('Classic');
    expect(starters.filter((s) => s.isDefault).map((s) => s.templateName)).toEqual(['Classic']);
  });

  it('Legacy Studio never becomes what a bill prints by itself — only as the default or when chosen', () => {
    const row = (name: string, preset: string, mode: 'BOTH' | 'WITH_GST', isDefault: boolean, isActive = true) => ({ id: name, templateName: name, layoutPreset: preset, supportedMode: mode, isDefault, isActive });
    // Default fits only GST bills; Classic / Compact inactive: a WITHOUT_GST bill keeps the built-in Classic.
    const tenant = [row('Detailed GST', 'DETAILED', 'WITH_GST', true), row('Classic', 'CLASSIC', 'BOTH', false, false), row('Legacy Studio', 'STUDIO', 'BOTH', false)];
    expect(pickInvoiceTemplate(tenant, 'WITHOUT_GST')).toBeNull();
    expect(pickInvoiceTemplate(tenant, 'WITH_GST')?.templateName).toBe('Detailed GST');
    // Made the default by the tenant: then it prints.
    expect(pickInvoiceTemplate([row('Classic', 'CLASSIC', 'BOTH', false), row('Legacy Studio', 'STUDIO', 'BOTH', true)], 'WITHOUT_GST')?.templateName).toBe('Legacy Studio');
  });

  it('existing templates render exactly as before when no print settings are configured', () => {
    const m = model({ template: classic(), print: undefined, payments: { paid: 100, outstanding: 1 } });
    expect(m.style.headerLayout).toBe('STACKED');
    expect(m.style.paperSize).toBe('A4');
    expect(m.accent).toBe(INVOICE_ACCENT_COLORS.NEUTRAL);
    expect(m.footer).toMatchObject({ note: null, text: null, bank: null, receivedBy: false, terms: null });
    expect(m.amountInWords).toBeNull();
    // Classic does not print payments, even when they are known.
    expect(m.totals.map((t) => t.label)).not.toContain('Advance / Received');
  });
});

describe('the render model takes from Print & Invoice settings', () => {
  it('Legacy Studio: side letterhead, copy label, discount column, amount in words, payments, Received By', () => {
    const bill = sampleInvoiceBill('WITH_GST');
    const m = model({ bill, payments: { paid: 5000, outstanding: bill.grandTotal - 5000 } });
    expect(m.style).toMatchObject({ preset: 'STUDIO', headerLayout: 'SIDE', tableBorders: 'rows', headerFill: false });
    expect(m.copyLabel).toBe('Original');
    expect(m.columns.map((c) => c.key)).toEqual(['serial', 'item', 'product', 'quantity', 'rate', 'amount', 'discount', 'gstRate', 'gstAmount', 'total']);
    // Each line's discount is its STORED allocation, formatted — never re-derived.
    const di = m.columns.findIndex((c) => c.key === 'discount');
    expect(m.rows.map((r) => r[di])).toEqual(bill.items.map((l) => l.discountAllocated.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')));
    expect(m.amountInWords).toBe(amountInWords(bill.grandTotal));
    const labels = m.totals.map((t) => t.label);
    expect(labels.slice(-3)).toEqual(['Grand Total', 'Advance / Received', 'Balance Due']);
    expect(m.totals.at(-2)?.value).toBe('5,000.00');
    expect(m.footer.receivedBy).toBe(true);
  });

  it('WITHOUT GST: no GST columns, and no Discount column on a bill without a discount', () => {
    const bill = { ...sampleInvoiceBill('WITHOUT_GST'), discountType: 'NONE' as const, discountValue: 0, discountAmount: 0 };
    const keys = model({ bill }).columns.map((c) => c.key);
    expect(keys).not.toContain('gstRate');
    expect(keys).not.toContain('gstAmount');
    expect(keys).not.toContain('discount');
    expect(keys).not.toContain('amount');
  });

  it('payments are printed only as given — none given (unknown), none printed', () => {
    expect(model({ payments: null }).totals.map((t) => t.label)).not.toContain('Balance Due');
  });

  it('copy label: settings default, per-print override, or none', () => {
    expect(model({ print: print({ copyLabel: 'OFFICE_COPY' }) }).copyLabel).toBe('Office Copy');
    expect(model({ print: print({ copyLabel: 'ORIGINAL' }), copy: 'DUPLICATE' }).copyLabel).toBe('Duplicate');
    expect(model({ copy: 'NONE' }).copyLabel).toBeNull();
  });

  it('accent is the preset colour', () => expect(model({ print: print({ accent: 'MAROON' }) }).accent).toBe(INVOICE_ACCENT_COLORS.MAROON));

  it('bank: only filled lines, collapsed when empty or switched off — never "IFSC -"', () => {
    expect(model({ print: print() }).footer.bank).toBeNull();
    const partial = model({ print: print({ bank: { ...DEFAULT_PRINT_SETTINGS.bank, accountNumber: '123', ifsc: 'SBIN0001234' } }) }).footer.bank;
    expect(partial).toEqual([{ label: 'A/c No.', value: '123' }, { label: 'IFSC', value: 'SBIN0001234' }]);
    expect(model({ print: print({ bank, showBankDetails: false }) }).footer.bank).toBeNull();
  });

  it('terms: the template’s own text wins; else the settings’ terms when shown; a template that hides terms prints none', () => {
    expect(model({ print: print({ terms: 'Company terms' }) }).footer.terms).toBe('Company terms');
    expect(model({ print: print({ terms: 'Company terms', showTerms: false }) }).footer.terms).toBeNull();
    const own = legacy();
    own.config.footer.terms = 'Template terms';
    expect(model({ template: own, print: print({ terms: 'Company terms' }) }).footer.terms).toBe('Template terms');
    expect(model({ template: classic(), print: print({ terms: 'Company terms' }) }).footer.terms).toBeNull();
  });

  it('images obey their switches, and a missing image is simply absent', () => {
    const on = model({ print: print() });
    expect(on.header.logo).not.toBeNull();
    expect(on.footer.signatureImage).toMatchObject({ version: '2' });
    expect(on.footer.footerImage).toMatchObject({ version: '3' });
    const off = model({ print: print({ showLogo: false, showSignature: false, showFooterImage: false }) });
    expect([off.header.logo, off.footer.signatureImage, off.footer.footerImage]).toEqual([null, null, null]);
    const none = model({ company: { ...company, logo: null, signature: null, footerImage: null } });
    expect([none.header.logo, none.footer.signatureImage, none.footer.footerImage]).toEqual([null, null, null]);
    // No signatory block, no signature image.
    const noSign = legacy();
    noSign.config.footer.showSignatory = false;
    expect(model({ template: noSign }).footer.signatureImage).toBeNull();
  });

  it('note, footer text and page numbers', () => {
    const m = model({ print: print({ invoiceNote: 'Photos kept 90 days', footerText: 'Thank you', showPageNumbers: false }) });
    expect(m.footer.note).toBe('Photos kept 90 days');
    expect(m.footer.text).toBe('Thank you');
    expect(m.showPageNumbers).toBe(false);
  });

  it('A5 is a real A5 page with narrower margins and a readable type size', () => {
    const t = legacy();
    t.config.page.paperSize = 'A5';
    const s = model({ template: t }).style;
    expect([Math.round(s.pageWidth), Math.round(s.pageHeight)]).toEqual([420, 595]);
    expect(s.margin).toBeLessThan(36);
    expect(s.fontSize).toBeGreaterThanOrEqual(7);
  });
});

describe('Legacy Studio PDF', () => {
  const full = () => print({ bank, terms: 'Goods once delivered will not be taken back.', invoiceNote: 'Photos kept 90 days', footerText: 'Thank you for choosing us' });

  it('prints the whole structure — letterhead, copy label, words, payments, bank, Received By, signatory', async () => {
    const bill = sampleInvoiceBill('WITH_GST');
    const m = model({ bill, print: full(), payments: { paid: 5000, outstanding: bill.grandTotal - 5000 } });
    const bytes = await renderInvoicePdf(m, { logo: img, signature: img, footer: img });
    const [page] = await pdfPages(bytes);
    for (const s of ['Sunrise Photo Studio', 'ORIGINAL', 'TAX INVOICE', 'Discount', 'Amount in words', 'Rupees', 'Advance / Received', 'Balance Due', 'BANK DETAILS', 'SBIN0001234', 'Received By', 'Authorised Signatory', 'For Sunrise Photo Studio', 'Photos kept 90 days', 'Thank you for choosing us', 'Page 1 of 1']) {
      expect(page.text, s).toContain(s);
    }
    expect(imageCount(bytes)).toBe(3);
  });

  it('WITHOUT GST, no images configured, page numbers off: nothing broken, nothing blank', async () => {
    const bytes = await renderInvoicePdf(model({ bill: sampleInvoiceBill('WITHOUT_GST'), print: print({ showPageNumbers: false }), company: { ...company, logo: null, signature: null, footerImage: null } }), null);
    const [page] = await pdfPages(bytes);
    expect(page.text).toContain('INVOICE');
    expect(page.text).not.toContain('Page 1');
    expect(page.text).not.toContain('BANK DETAILS');
    expect(imageCount(bytes)).toBe(0);
  });

  it('a signature image the PDF cannot embed is skipped, not faked', async () => {
    const bytes = await renderInvoicePdf(model({ print: print() }), { logo: img, signature: { data: new Uint8Array([1, 2, 3]), contentType: 'image/webp' }, footer: null });
    expect(imageCount(bytes)).toBe(1);
  });

  it('many items and long terms: more pages, totals and signatures intact, deterministic', async () => {
    const base = sampleInvoiceBill('WITH_GST');
    const items = Array.from({ length: 60 }, (_, i) => ({ ...base.items[i % base.items.length], remark: i % 7 === 0 ? 'A long remark that wraps onto a second line in the product table' : null }));
    const bill = { ...base, customerName: 'A Very Long Customer Name That Keeps Going For Testing Wrapping Behaviour', items };
    const m = model({ bill, print: full(), payments: { paid: 0, outstanding: base.grandTotal } });
    m.footer.terms = Array.from({ length: 40 }, (_, i) => `${i + 1}. A term line that is long enough to wrap across the width of the page when printed.`).join('\n');
    const at = new Date('2026-09-26T10:00:00Z');
    const a = await renderInvoicePdf(m, { signature: img, footer: img }, { date: at });
    const b = await renderInvoicePdf(m, { signature: img, footer: img }, { date: at });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const pages = await pdfPages(a);
    expect(pages.length).toBeGreaterThan(2);
    const all = pages.map((p) => p.text).join(' ');
    for (const s of ['Grand Total', 'Balance Due', 'Received By', 'Authorised Signatory', '40. A term line']) expect(all).toContain(s);
    expect(pages.at(-1)!.text).toContain(`Page ${pages.length} of ${pages.length}`);
  });

  it('A5 renders on an A5 page', async () => {
    const t = legacy();
    t.config.page.paperSize = 'A5';
    const pages = await pdfPages(await renderInvoicePdf(model({ template: t, print: print({ bank }) }), null));
    expect([Math.round(pages[0].width), Math.round(pages[0].height)]).toEqual([420, 595]);
    expect(pages.map((p) => p.text).join(' ')).toContain('Grand Total');
  });
});

/* ================================================= B — database ===== */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Print & Invoice (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;
  let eq: typeof import('drizzle-orm').eq;

  const tenantIds: string[] = [];
  const FULL = { operations_billing: ['read', 'create', 'update', 'delete'], operations_receipts: ['read', 'create', 'update'], settings_invoice_templates: ['read', 'create', 'update', 'delete'], settings_general: ['read', 'update'] };
  const req = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });
  const upload = (t: string, kind: string, file: Buffer, type = 'image/png') => {
    const boundary = `----studiocrm${Math.random().toString(36).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="img.png"\r\nContent-Type: ${type}\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'PUT', url: `/api/settings/print-assets/${kind}`, headers: { authorization: `Bearer ${t}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  };

  const T = { a: { tenantId: '', admin: '', billingOnly: '', general: '', bill: '', noGst: '', cash: '' }, b: { tenantId: '', admin: '' } };

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
    return { tenantId: tenant.id, user, admin: await user(FULL) };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ inArray, eq } = await import('drizzle-orm'));
    const client = await import('../db/client');
    // Fail closed before the first write: the pool must really be on the throwaway database.
    await (await import('../test-support/dbGuard')).assertTestDatabase(client, TEST_DB);
    ({ db, sql: sqlClient, schema } = client);
    app = await (await import('../server')).buildApp();
    await app.ready();

    const a = await seedTenant('prt-a');
    const [book] = await db.insert(schema.books).values({ tenantId: a.tenantId, bookNumber: 'P-2026', seriesStartsAt: 1, nextBillNumber: 1 }).returning();
    const [ng] = await db.insert(schema.books).values({ tenantId: a.tenantId, bookNumber: 'PN-2026', seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId: a.tenantId, itemName: 'Photography', hsnCode: '9983', gstRate: '5.00' }).returning();
    const [sub] = await db.insert(schema.subItems).values({ tenantId: a.tenantId, itemId: item.id, productName: 'Newborn Shoot', rate: '10000.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId: a.tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId: a.tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    const bill = async (bookId: string, taxMode: string) => {
      const r = await req(a.admin, 'POST', '/api/bills', { bookId, billDate: '2026-09-20', customerName: 'Print Customer', mobileNumber: '9876500011', taxMode, discountType: 'AMOUNT', discountValue: 500, items: [{ itemId: item.id, subItemId: sub.id, quantity: 1, rate: 10000 }] });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().data.id as string;
    };
    Object.assign(T.a, { tenantId: a.tenantId, admin: a.admin, bill: await bill(book.id, 'WITH_GST'), noGst: await bill(ng.id, 'WITHOUT_GST'), cash: cash.id });
    T.a.billingOnly = await a.user({ operations_billing: ['read'] });
    T.a.general = await a.user({ settings_general: ['read', 'update'] });
    const b = await seedTenant('prt-b');
    Object.assign(T.b, { tenantId: b.tenantId, admin: b.admin });
  });

  afterAll(async () => {
    if (tenantIds.length) {
      const t = tenantIds;
      for (const tbl of [schema.advanceApplications, schema.receiptAllocations, schema.receipts, schema.publicInvoiceLinks, schema.billWorkStages, schema.billItems, schema.bills, schema.appointments, schema.accounts, schema.accountGroups, schema.subItems, schema.items, schema.books, schema.documentCounters, schema.invoiceTemplates, schema.companyPrintAssets, schema.companyLogos, schema.branches, schema.companies, schema.appSettings, schema.activityLogs, schema.users, schema.roles] as const) {
        await db.delete(tbl).where(inArray((tbl as any).tenantId, t));
      }
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, t));
    }
    await app?.close();
    await sqlClient?.end();
  });

  const full = { ...DEFAULT_PRINT_SETTINGS, bank, terms: 'Company terms', invoiceNote: 'Note', footerText: 'Footer', accent: 'TEAL', copyLabel: 'DUPLICATE', defaultDeliveryDays: 3 };

  it('saves and reads back; defaults before any save; General settings can never change them', async () => {
    expect((await req(T.b.admin, 'GET', '/api/settings')).json().data.print).toEqual(DEFAULT_PRINT_SETTINGS);
    const saved = await req(T.a.admin, 'PUT', '/api/settings/print', full);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await req(T.a.billingOnly, 'GET', '/api/settings')).json().data.print).toMatchObject({ accent: 'TEAL', copyLabel: 'DUPLICATE', defaultDeliveryDays: 3, bank });
    // A General save carrying a `print` key changes nothing of them.
    const g = await req(T.a.general, 'PUT', '/api/settings', { dateFormat: 'dd/MM/yyyy', print: { ...DEFAULT_PRINT_SETTINGS } });
    expect(g.statusCode, g.body).toBe(200);
    expect((await req(T.a.admin, 'GET', '/api/settings')).json().data.print.accent).toBe('TEAL');
  });

  it('is tenant-isolated: one tenant’s settings never reach another', async () => {
    expect((await req(T.b.admin, 'GET', '/api/settings')).json().data.print.bank).toEqual(DEFAULT_PRINT_SETTINGS.bank);
  });

  it('RBAC: only Invoice Templates update may change them; invalid bodies are refused', async () => {
    expect((await req(T.a.billingOnly, 'PUT', '/api/settings/print', full)).statusCode).toBe(403);
    expect((await req(T.a.general, 'PUT', '/api/settings/print', full)).statusCode).toBe(403);
    expect((await req(T.a.admin, 'PUT', '/api/settings/print', { ...full, accent: 'NEON' })).statusCode).toBe(400);
    expect((await req(T.a.billingOnly, 'PUT', '/api/settings/print-assets/signature')).statusCode).toBe(403);
    expect((await req(T.a.billingOnly, 'DELETE', '/api/settings/print-assets/signature')).statusCode).toBe(403);
  });

  it('print images: PNG accepted; wrong bytes, oversize and unknown kinds refused; readable in-tenant only', async () => {
    const ok = await upload(T.a.admin, 'signature', PNG);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await upload(T.a.admin, 'footer', PNG)).statusCode).toBe(200);
    expect((await upload(T.a.admin, 'signature', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png')).statusCode).toBe(400);
    expect((await upload(T.a.admin, 'signature', Buffer.alloc(1024 * 1024 + 10, 1))).statusCode).toBe(400);
    expect((await upload(T.a.admin, 'stamp', PNG)).statusCode).toBe(404);
    // WebP by its own bytes: refused — the PDF could not embed it (the form converts to PNG first).
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 1)]);
    expect((await upload(T.a.admin, 'signature', webp, 'image/webp')).statusCode).toBe(400);
    const profile = (await req(T.a.billingOnly, 'GET', '/api/settings/company')).json().data;
    expect(profile.signature?.contentType).toBe('image/png');
    expect(profile.footerImage?.contentType).toBe('image/png');
    const read = await req(T.a.billingOnly, 'GET', '/api/settings/print-assets/signature');
    expect(read.statusCode).toBe(200);
    expect(read.headers['content-type']).toBe('image/png');
    expect((await req(T.b.admin, 'GET', '/api/settings/print-assets/signature')).statusCode).toBe(404);
  });

  it('Legacy Studio: a new tenant has it; an existing tenant gets it once, never as default, never again after delete', async () => {
    const list = async (t: string) => (await req(t, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string; isDefault: boolean }[];
    const a = await list(T.a.admin);
    expect(a.map((t) => t.templateName).sort()).toEqual(['Classic', 'Compact', 'Detailed GST', 'Legacy Studio']);
    expect(a.find((t) => t.isDefault)?.templateName).toBe('Classic');
    // An existing tenant seeded BEFORE Legacy Studio: only the three old starters, no marker.
    const old = await seedTenant('prt-old');
    await db.delete(schema.invoiceTemplates).where(eq(schema.invoiceTemplates.tenantId, old.tenantId));
    for (const s of starterInvoiceTemplates().filter((x) => x.templateName !== 'Legacy Studio')) await db.insert(schema.invoiceTemplates).values({ tenantId: old.tenantId, ...s });
    const before = await db.select().from(schema.appSettings).where(eq(schema.appSettings.tenantId, old.tenantId));
    await db.update(schema.appSettings).set({ settings: { ...((before[0]?.settings as object) ?? {}), invoiceTemplateSeeds: [] } }).where(eq(schema.appSettings.tenantId, old.tenantId));
    const got = await list(old.admin);
    const legacyRow = got.find((t) => t.templateName === 'Legacy Studio');
    expect(legacyRow).toBeDefined();
    expect(legacyRow!.isDefault).toBe(false);
    expect(got.find((t) => t.isDefault)?.templateName).toBe('Classic');
    expect(await list(old.admin)).toHaveLength(4);
    expect((await req(old.admin, 'DELETE', `/api/settings/invoice-templates/${legacyRow!.id}`)).statusCode).toBe(200);
    expect((await list(old.admin)).map((t) => t.templateName)).not.toContain('Legacy Studio');
  });

  it('a real bill: payments are the derived Paid — cancelled receipts and unapplied advance excluded; the bill is untouched', async () => {
    const templatesA = (await req(T.a.admin, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string }[];
    const legacyId = templatesA.find((t) => t.templateName === 'Legacy Studio')!.id;
    const billBefore = (await req(T.a.admin, 'GET', `/api/bills/${T.a.bill}`)).json().data;
    const grand = Number(billBefore.grandTotal);
    const receipt = (amount: number, allocate: number) =>
      req(T.a.admin, 'POST', '/api/receipts', { receiptDate: '2026-09-21', customerMobile: '9876500011', customerName: 'Print Customer', paymentMode: 'CASH', accountId: T.a.cash, amount, allocations: allocate ? [{ billId: T.a.bill, amount: allocate }] : [] });
    const r1 = await receipt(3000, 2000); // 2000 on the bill, 1000 UNAPPLIED advance
    expect(r1.statusCode, r1.body).toBe(200);
    const r2 = await receipt(500, 500);
    expect(r2.statusCode, r2.body).toBe(200);
    expect((await req(T.a.admin, 'POST', `/api/receipts/${r2.json().data.id}/cancel`, { reason: 'test' })).statusCode).toBe(200);

    const inv = await req(T.a.billingOnly, 'GET', `/api/bills/${T.a.bill}/invoice?templateId=${legacyId}`);
    expect(inv.statusCode, inv.body).toBe(200);
    const m = inv.json().data;
    const row = (label: string) => m.totals.find((t: { label: string }) => t.label === label)?.value;
    expect(row('Advance / Received')).toBe('2,000.00');
    expect(row('Balance Due')).toBe(`₹${(grand - 2000).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
    expect(m.copyLabel).toBe('Duplicate');
    expect(m.footer.bank.map((b: { label: string }) => b.label)).toEqual(['Bank', 'A/c Name', 'A/c No.', 'IFSC', 'Branch']);
    expect(m.amountInWords).toBe(amountInWords(grand));
    // Per-print copy label, validated.
    expect((await req(T.a.billingOnly, 'GET', `/api/bills/${T.a.bill}/invoice?templateId=${legacyId}&copy=OFFICE_COPY`)).json().data.copyLabel).toBe('Office Copy');
    expect((await req(T.a.billingOnly, 'GET', `/api/bills/${T.a.bill}/invoice?copy=TRIPLE`)).statusCode).toBe(400);

    // PDF, WITH and WITHOUT GST, with the uploaded signature and footer image.
    const pdf = await req(T.a.billingOnly, 'GET', `/api/bills/${T.a.bill}/invoice/pdf?templateId=${legacyId}`);
    expect(pdf.statusCode).toBe(200);
    expect(imageCount(pdf.rawPayload)).toBe(2); // no logo uploaded; signature + footer image
    const text = (await pdfPages(pdf.rawPayload)).map((p) => p.text).join(' ');
    for (const s of ['DUPLICATE', 'Advance / Received', 'Balance Due', 'BANK DETAILS', 'Received By']) expect(text).toContain(s);
    const pdfNg = await req(T.a.billingOnly, 'GET', `/api/bills/${T.a.noGst}/invoice/pdf?templateId=${legacyId}`);
    expect(pdfNg.statusCode).toBe(200);
    expect((await pdfPages(pdfNg.rawPayload)).map((p) => p.text).join(' ')).not.toContain('GST %');

    // Rendering wrote nothing to the bill.
    const billAfter = (await req(T.a.admin, 'GET', `/api/bills/${T.a.bill}`)).json().data;
    expect({ ...billAfter, updatedAt: null }).toEqual({ ...billBefore, updatedAt: null });
    expect(billAfter.updatedAt).toBe(billBefore.updatedAt);
  });

  it('the public invoice link serves the same Legacy Studio PDF, with its images', async () => {
    const legacyId = ((await req(T.a.admin, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string }[]).find((t) => t.templateName === 'Legacy Studio')!.id;
    const link = await req(T.a.billingOnly, 'POST', `/api/bills/${T.a.bill}/invoice/public-link`, { templateId: legacyId });
    expect(link.statusCode, link.body).toBe(200);
    const path = new URL(link.json().data.url).pathname;
    const pub = await app.inject({ method: 'GET', url: path });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('application/pdf');
    expect(imageCount(pub.rawPayload)).toBe(2);
    expect((await pdfPages(pub.rawPayload)).map((p) => p.text).join(' ')).toContain('Balance Due');
  });
});
