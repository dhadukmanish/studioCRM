import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_PRINT_SETTINGS,
  PROFESSIONAL_STUDIO_TEMPLATE_NAME,
  buildInvoiceModel,
  invoiceTemplateSchema,
  pickInvoiceTemplate,
  professionalStudioTemplate,
  sampleInvoiceBill,
  starterInvoiceTemplates,
  type CompanyProfile,
  type InvoiceBillSource,
  type InvoiceTemplateSource,
  type PrintSettings,
} from '@erp/shared';
import { renderInvoicePdf } from '../services/invoicePdf';

/**
 * The "Professional Studio" invoice template (docs/INVOICE_TEMPLATES.md): a modern tax-invoice
 * layout drawn by the SAME model and renderers as every other template. Section A is pure and always
 * runs (registration, the render model, real PDFs parsed back). Section B needs TEST_DATABASE_URL
 * (a THROWAWAY database): seeding into new and existing tenants, a real bill, the public link.
 *
 * It has ONE customer + bill section: "Bill To" / "Ship To" must never print.
 */

const pro = (): InvoiceTemplateSource => ({ id: 'tpl-pro', ...structuredClone(professionalStudioTemplate()) });
const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-00000000c0de', name: 'Sunrise Photo Studio', legalName: null, taxId: '24ABCDE1234F1Z5', email: 'hello@sunrise.example', phone: '98250 12345', website: 'sunrise.example',
  addressLine1: '12, Station Road', addressLine2: null, city: 'Rajkot', state: 'Gujarat', pincode: '360001', countryCode: 'IN', currency: 'INR',
  logo: { version: '1', contentType: 'image/png' }, signature: { version: '2', contentType: 'image/png' }, footerImage: { version: '3', contentType: 'image/png' },
};
const bare: CompanyProfile = { ...company, email: null, website: null, logo: null, signature: null, footerImage: null };
const print = (over: Partial<PrintSettings> = {}): PrintSettings => ({ ...structuredClone(DEFAULT_PRINT_SETTINGS), ...over });
const bank = { bankName: 'State Bank of India', accountName: 'Sunrise Photo Studio', accountNumber: '12345678901', ifsc: 'SBIN0001234', branch: 'Station Road' };
const model = (o: { bill?: InvoiceBillSource; template?: InvoiceTemplateSource; print?: PrintSettings; payments?: { paid: number; outstanding: number } | null; copy?: 'NONE' | 'ORIGINAL' | 'DUPLICATE' | 'OFFICE_COPY'; company?: CompanyProfile | null } = {}) =>
  buildInvoiceModel({ bill: o.bill ?? sampleInvoiceBill('WITH_GST'), company: o.company === undefined ? company : o.company, dateFormat: 'dd/MM/yyyy', template: o.template ?? pro(), print: o.print, payments: o.payments, copyLabel: o.copy });
const noDiscount = (taxMode: 'WITH_GST' | 'WITHOUT_GST'): InvoiceBillSource => {
  const b = sampleInvoiceBill(taxMode);
  // A bill as saved without a discount: every line's taxable is its gross, nothing allocated.
  const items = b.items.map((l) => ({ ...l, discountAllocated: 0, taxableAmount: l.grossTaxable, gstAmount: taxMode === 'WITH_GST' ? Math.round(l.grossTaxable * l.gstRateSnapshot) / 100 : 0 }));
  const lines = items.map((l) => ({ ...l, lineTotal: Math.round((l.taxableAmount + l.gstAmount) * 100) / 100 }));
  const sub = lines.reduce((t, l) => t + l.grossTaxable, 0);
  const gst = lines.reduce((t, l) => t + l.gstAmount, 0);
  return { ...b, discountType: 'AMOUNT', discountValue: 0, discountAmount: 0, subTotal: sub, netTaxable: sub, gstAmount: gst, grandTotal: Math.round((sub + gst) * 100) / 100, items: lines };
};
const BILL_TO = /\bbill(ed)?\s+to\b/i;
const SHIP_TO = /\bship(ping)?\s+(to|address)\b|\bdelivery address\b/i;

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
const modelText = (m: ReturnType<typeof model>) => JSON.stringify({ ...m, style: null });

/* ======================================================= A — pure ===== */

describe('Professional Studio: registration', () => {
  it('is a valid BOTH starter on its own preset, never the default, and Classic stays the default', () => {
    const starters = starterInvoiceTemplates();
    const p = starters.find((s) => s.templateName === PROFESSIONAL_STUDIO_TEMPLATE_NAME)!;
    expect(p).toBeDefined();
    expect(p.layoutPreset).toBe('PROFESSIONAL');
    expect(p.supportedMode).toBe('BOTH');
    expect(p.isDefault).toBe(false);
    expect(invoiceTemplateSchema.safeParse({ ...p, isActive: true }).success).toBe(true);
    expect(starters.filter((s) => s.isDefault).map((s) => s.templateName)).toEqual(['Classic']);
    expect(starters[0].templateName).toBe('Classic');
  });

  it('is never picked by itself — only as the default or when chosen', () => {
    const row = (id: string, name: string, preset: string, isDefault = false) => ({ id, templateName: name, supportedMode: 'BOTH' as const, isDefault, isActive: true, layoutPreset: preset });
    // Only opt-in templates usable: none is picked, the built-in Classic prints.
    expect(pickInvoiceTemplate([row('p', 'Professional Studio', 'PROFESSIONAL'), row('l', 'Legacy Studio', 'STUDIO')], 'WITH_GST')).toBeNull();
    // Alphabetically first, still not picked over a regular template.
    expect(pickInvoiceTemplate([row('p', 'A Professional', 'PROFESSIONAL'), row('c', 'Compact', 'COMPACT')], 'WITH_GST')?.id).toBe('c');
    // Made the default by the tenant: it prints.
    expect(pickInvoiceTemplate([row('p', 'Professional Studio', 'PROFESSIONAL', true), row('c', 'Classic', 'CLASSIC')], 'WITHOUT_GST')?.id).toBe('p');
  });

  it('adding it changes nothing of the existing templates’ output', () => {
    const classic: InvoiceTemplateSource = { id: 'c', ...structuredClone(starterInvoiceTemplates()[0]) };
    const m = model({ template: classic });
    expect(m.header.contact).toEqual([]);
    expect(m.header.lines).toContain('Phone: 98250 12345   Email: hello@sunrise.example');
    expect(m.labels.billedTo).toBe('BILLED TO');
    expect(m.meta.map((f) => f.label)).toEqual(['Bill No.', 'Book', 'Bill Date', 'Delivery Date']);
    expect(m.style.headerLayout).toBe('STACKED');
  });
});

describe('Professional Studio: render model', () => {
  it('header: small title, company block with GSTIN, contact column (Mobile / Email / Web); copy label', () => {
    const m = model({ copy: 'OFFICE_COPY' });
    expect(m.style.headerLayout).toBe('BANNER');
    expect(m.title).toBe('Tax Invoice');
    expect(m.header.companyName).toBe('Sunrise Photo Studio');
    expect(m.header.lines).toEqual(['12, Station Road', 'Rajkot, Gujarat - 360001', 'GSTIN: 24ABCDE1234F1Z5']);
    expect(m.header.contact).toEqual(['Mobile: 98250 12345', 'Email: hello@sunrise.example', 'Web: sunrise.example']);
    expect(m.copyLabel).toBe('Office Copy');
    // Email / website not configured: simply absent, no empty labels.
    expect(model({ company: bare }).header.contact).toEqual(['Mobile: 98250 12345']);
  });

  it('ONE customer + bill section — no Bill To, no Ship To anywhere in the model', () => {
    const m = model();
    expect(m.labels.billedTo).toBe('CUSTOMER');
    expect(m.labels.details).toBe('BILL DETAILS');
    expect(m.customer.map((f) => f.label)).toEqual(['Name', 'Mobile', 'Baby Name', 'Birth Date']);
    expect(m.meta.map((f) => f.label)).toEqual(['Book No.', 'Bill No.', 'Bill Date', 'Planned Delivery']);
    expect(modelText(m)).not.toMatch(BILL_TO);
    expect(modelText(m)).not.toMatch(SHIP_TO);
    expect(modelText(m)).not.toMatch(/PO Number|Dispatch|Place of Supply|Payment Terms/i);
    // Empty rows are not printed.
    const bill = { ...sampleInvoiceBill('WITH_GST'), babyName: null, hasBirthDate: false, birthDate: null, deliveryDate: null };
    const e = model({ bill });
    expect(e.customer.map((f) => f.label)).toEqual(['Name', 'Mobile']);
    expect(e.meta.map((f) => f.label)).toEqual(['Book No.', 'Bill No.', 'Bill Date']);
  });

  it('WITH GST and a discount: every line reconciles — Qty x Rate - Discount + GST = Total', () => {
    const bill = sampleInvoiceBill('WITH_GST');
    const m = model({ bill });
    expect(m.columns.map((c) => c.label)).toEqual(['#', 'Item', 'Product', 'Qty', 'Rate', 'Discount', 'GST%', 'GST', 'Total']);
    const n = (s: string) => Number(s.replace(/[₹,]/g, ''));
    m.rows.forEach((r, i) => {
      const [qty, rate, disc, , gst, total] = [n(r[3]), n(r[4]), n(r[5]), r[6], n(r[7]), n(r[8])];
      // Qty x Rate is the stored gross, rounded to the paisa: within half a paisa of the product.
      expect(Math.abs(qty * rate - disc + gst - total), `line ${i + 1}`).toBeLessThan(0.006);
      expect(total).toBe(bill.items[i].lineTotal);
    });
    expect(m.totals.map((t) => t.label)).toEqual(['Sub Total', 'Discount (5%)', 'GST', 'Grand Total']);
    expect(m.totals.find((t) => t.strong)?.label).toBe('Grand Total');
    expect(m.amountInWords).toMatch(/^Rupees .* Only$/);
    expect(m.labels.amountInWords).toBe('Total in words');
    expect(m.gstSummary).toBeNull();
  });

  it('no discount: no Discount column and no Discount row', () => {
    const m = model({ bill: noDiscount('WITH_GST') });
    expect(m.columns.map((c) => c.key)).not.toContain('discount');
    expect(m.totals.map((t) => t.label)).toEqual(['Sub Total', 'GST', 'Grand Total']);
  });

  it('WITHOUT GST: no GST columns, no GST row, no fake zero — and "Invoice", not "Tax Invoice"', () => {
    const m = model({ bill: noDiscount('WITHOUT_GST') });
    expect(m.title).toBe('Invoice');
    expect(m.columns.map((c) => c.label)).toEqual(['#', 'Item', 'Product', 'Qty', 'Rate', 'Amount']);
    expect(m.totals.map((t) => t.label)).toEqual(['Sub Total', 'Grand Total']);
    const d = model({ bill: sampleInvoiceBill('WITHOUT_GST') });
    expect(d.columns.map((c) => c.label)).toEqual(['#', 'Item', 'Product', 'Qty', 'Rate', 'Discount', 'Amount']);
    expect(d.totals.map((t) => t.label)).toEqual(['Sub Total', 'Discount (5%)', 'Grand Total']);
  });

  it('Advance / Received and Balance Due only as the server derived them', () => {
    const bill = sampleInvoiceBill('WITH_GST');
    const m = model({ bill, payments: { paid: 5000, outstanding: bill.grandTotal - 5000 } });
    expect(m.totals.slice(-2)).toEqual([
      { label: 'Advance / Received', value: '5,000.00', strong: false },
      { label: 'Balance Due', value: expect.stringMatching(/^₹/), strong: false, bold: true },
    ]);
    expect(model({ payments: null }).totals.map((t) => t.label)).not.toContain('Balance Due');
  });

  it('logo / signature / footer image / bank: present when configured, absent otherwise', () => {
    const full = model({ print: print({ bank }) });
    expect(full.header.logo).not.toBeNull();
    expect(full.footer.signatureImage).not.toBeNull();
    expect(full.footer.footerImage).not.toBeNull();
    expect(full.footer.bank?.map((b) => b.label)).toEqual(['Bank', 'A/c Name', 'A/c No.', 'IFSC', 'Branch']);
    expect(full.footer.receivedBy).toBe(true);
    const none = model({ company: bare, print: print() });
    expect([none.header.logo, none.footer.signatureImage, none.footer.footerImage, none.footer.bank]).toEqual([null, null, null, null]);
    const partial = model({ print: print({ bank: { ...DEFAULT_PRINT_SETTINGS.bank, bankName: 'SBI', ifsc: 'SBIN0001234' } }) });
    expect(partial.footer.bank?.map((b) => b.label)).toEqual(['Bank', 'IFSC']);
    expect(model({ print: print({ bank, showBankDetails: false, showLogo: false, showSignature: false }) })).toMatchObject({ header: { logo: null }, footer: { bank: null, signatureImage: null } });
  });

  it('terms come from Print & Invoice settings', () => {
    expect(model({ print: print({ terms: 'No refunds.' }) }).footer.terms).toBe('No refunds.');
    expect(model({ print: print({ terms: 'No refunds.', showTerms: false }) }).footer.terms).toBeNull();
  });
});

describe('Professional Studio PDF', () => {
  const full = () => print({ bank, terms: 'Goods once delivered will not be taken back.\nSubject to local jurisdiction.', accent: 'BLUE' });

  it('WITH GST: the whole hierarchy prints — and no Bill To / Ship To', async () => {
    const bill = sampleInvoiceBill('WITH_GST');
    const bytes = await renderInvoicePdf(model({ bill, print: full(), payments: { paid: 5000, outstanding: bill.grandTotal - 5000 } }), { logo: img, signature: img, footer: img });
    const [page] = await pdfPages(bytes);
    for (const s of ['TAX INVOICE', 'ORIGINAL', 'Sunrise Photo Studio', 'GSTIN: 24ABCDE1234F1Z5', 'Mobile: 98250 12345', 'Email: hello@sunrise.example', 'CUSTOMER', 'BILL DETAILS', 'Book No.', 'Planned Delivery', 'Discount', 'GST%', 'Total in words', 'Rupees', 'BANK DETAILS', 'SBIN0001234', 'Grand Total', 'Advance / Received', 'Balance Due', 'TERMS & CONDITIONS', 'Subject to local jurisdiction.', 'Received By', 'For Sunrise Photo Studio', 'Authorised Signatory', 'Page 1 of 1']) {
      expect(page.text, s).toContain(s);
    }
    expect(page.text).not.toMatch(BILL_TO);
    expect(page.text).not.toMatch(SHIP_TO);
    expect(imageCount(bytes)).toBe(3);
  });

  it('WITHOUT GST, no logo / signature / bank: nothing broken, nothing blank', async () => {
    const bytes = await renderInvoicePdf(model({ bill: noDiscount('WITHOUT_GST'), company: bare, print: print({ showPageNumbers: false }) }), null);
    const [page] = await pdfPages(bytes);
    expect(page.text).toContain('INVOICE');
    expect(page.text).not.toContain('TAX INVOICE');
    for (const s of ['GST%', 'BANK DETAILS', 'Page 1', 'Discount']) expect(page.text, s).not.toContain(s);
    expect(page.text).toContain('Authorised Signatory');
    expect(imageCount(bytes)).toBe(0);
  });

  it('copy label prints; NONE prints nothing', async () => {
    expect((await pdfPages(await renderInvoicePdf(model({ copy: 'DUPLICATE' }), null)))[0].text).toContain('DUPLICATE');
    const none = (await pdfPages(await renderInvoicePdf(model({ copy: 'NONE' }), null)))[0].text;
    for (const s of ['ORIGINAL', 'DUPLICATE', 'OFFICE COPY']) expect(none).not.toContain(s);
  });

  it('many items and long terms: more pages, totals / terms / signatures intact, deterministic', async () => {
    const base = sampleInvoiceBill('WITH_GST');
    const items = Array.from({ length: 60 }, (_, i) => ({ ...base.items[i % base.items.length], remark: null }));
    const m = model({ bill: { ...base, items }, print: full(), payments: { paid: 0, outstanding: base.grandTotal } });
    m.footer.terms = Array.from({ length: 40 }, (_, i) => `${i + 1}. A term line that is long enough to wrap across the width of the page when printed.`).join('\n');
    const at = new Date('2026-09-27T10:00:00Z');
    const a = await renderInvoicePdf(m, { logo: img, signature: img }, { date: at });
    const b = await renderInvoicePdf(m, { logo: img, signature: img }, { date: at });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const pages = await pdfPages(a);
    expect(pages.length).toBeGreaterThan(2);
    const all = pages.map((p) => p.text).join(' ');
    for (const s of ['Grand Total', 'Balance Due', 'BANK DETAILS', '40. A term line', 'Received By', 'Authorised Signatory']) expect(all).toContain(s);
    // The table header repeats on every page that continues the table.
    expect(pages[1].text).toContain('GST%');
    expect(pages.at(-1)!.text).toContain(`Page ${pages.length} of ${pages.length}`);
  });

  it('A5 renders on an A5 page with the same content', async () => {
    const t = pro();
    t.config.page.paperSize = 'A5';
    const pages = await pdfPages(await renderInvoicePdf(model({ template: t, print: print({ bank }), payments: { paid: 100, outstanding: 1 } }), { logo: img }));
    expect([Math.round(pages[0].width), Math.round(pages[0].height)]).toEqual([420, 595]);
    const all = pages.map((p) => p.text).join(' ');
    for (const s of ['TAX INVOICE', 'Grand Total', 'Balance Due', 'BANK DETAILS', 'Authorised Signatory']) expect(all).toContain(s);
  });
});

describe('existing templates are pinned (their PDF text must not change with Professional Studio)', () => {
  // Snapshots of the printed text, in drawing order, of every other starter — WITH and WITHOUT GST,
  // with every Print & Invoice setting filled. A change to a shared drawing helper that moves or
  // drops anything on Classic / Compact / Detailed / Legacy Studio fails here.
  const full = print({ bank, terms: 'Goods once delivered will not be taken back.', invoiceNote: 'Photos kept 90 days', footerText: 'Thank you', accent: 'TEAL' });
  for (const t of starterInvoiceTemplates().filter((x) => x.layoutPreset !== 'PROFESSIONAL')) {
    for (const mode of ['WITH_GST', 'WITHOUT_GST'] as const) {
      it(`${t.templateName}, ${mode}`, async () => {
        const bill = sampleInvoiceBill(mode);
        const m = model({ bill, template: { id: 'x', ...structuredClone(t) }, print: full, payments: { paid: 1000, outstanding: bill.grandTotal - 1000 } });
        const pages = await pdfPages(await renderInvoicePdf(m, { logo: img, signature: img, footer: img }, { date: new Date('2026-01-01') }));
        expect(pages.map((p) => p.text)).toMatchSnapshot();
      });
    }
  }
});

/* ================================================= B — database ===== */

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('Professional Studio (integration, needs TEST_DATABASE_URL)', () => {
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
  const T = { tenantId: '', admin: '', reader: '', bill: '', noGst: '', cash: '' };

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
  const list = async (t: string) => (await req(t, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string; isDefault: boolean; layoutPreset: string }[];

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

    const a = await seedTenant('pro-a');
    const [book] = await db.insert(schema.books).values({ tenantId: a.tenantId, bookNumber: 'PR-2026', seriesStartsAt: 1, nextBillNumber: 1 }).returning();
    const [ng] = await db.insert(schema.books).values({ tenantId: a.tenantId, bookNumber: 'PRN-2026', seriesStartsAt: 1, nextBillNumber: 1, seriesType: 'WITHOUT_GST' }).returning();
    const [item] = await db.insert(schema.items).values({ tenantId: a.tenantId, itemName: 'Photography', hsnCode: '9983', gstRate: '18.00' }).returning();
    const [sub] = await db.insert(schema.subItems).values({ tenantId: a.tenantId, itemId: item.id, productName: 'Newborn Shoot', rate: '10000.00' }).returning();
    const [cashG] = await db.insert(schema.accountGroups).values({ tenantId: a.tenantId, groupName: 'CASH', headGroup: 'CASH' }).returning();
    const [cash] = await db.insert(schema.accounts).values({ tenantId: a.tenantId, accountGroupId: cashG.id, accountName: 'CASH IN HAND' }).returning();
    const bill = async (bookId: string, taxMode: string) => {
      const r = await req(a.admin, 'POST', '/api/bills', { bookId, billDate: '2026-09-20', customerName: 'Pro Customer', mobileNumber: '9876500022', taxMode, discountType: 'AMOUNT', discountValue: 500, items: [{ itemId: item.id, subItemId: sub.id, quantity: 2, rate: 10000 }] });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().data.id as string;
    };
    Object.assign(T, { tenantId: a.tenantId, admin: a.admin, bill: await bill(book.id, 'WITH_GST'), noGst: await bill(ng.id, 'WITHOUT_GST'), cash: cash.id });
    T.reader = await a.user({ operations_billing: ['read'] });
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

  it('a new tenant has it, on the Professional preset, and Classic stays the default', async () => {
    const rows = await list(T.admin);
    expect(rows.map((t) => t.templateName).sort()).toEqual(['Classic', 'Compact', 'Detailed GST', 'Legacy Studio', 'Professional Studio']);
    expect(rows.find((t) => t.templateName === 'Professional Studio')).toMatchObject({ layoutPreset: 'PROFESSIONAL', isDefault: false });
    expect(rows.find((t) => t.isDefault)?.templateName).toBe('Classic');
  });

  it('an existing tenant gets it once, never as default, never again after delete; its default is untouched', async () => {
    const old = await seedTenant('pro-old');
    // Seeded before Professional Studio: the older starters, Compact as the tenant's chosen default, only the Legacy marker.
    await db.delete(schema.invoiceTemplates).where(eq(schema.invoiceTemplates.tenantId, old.tenantId));
    for (const s of starterInvoiceTemplates().filter((x) => x.templateName !== PROFESSIONAL_STUDIO_TEMPLATE_NAME)) {
      await db.insert(schema.invoiceTemplates).values({ tenantId: old.tenantId, ...s, isDefault: s.templateName === 'Compact' });
    }
    const [before] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.tenantId, old.tenantId));
    await db.update(schema.appSettings).set({ settings: { ...((before?.settings as object) ?? {}), invoiceTemplateSeeds: ['LEGACY_STUDIO'] } }).where(eq(schema.appSettings.tenantId, old.tenantId));
    const got = await list(old.admin);
    const row = got.find((t) => t.templateName === 'Professional Studio');
    expect(row).toMatchObject({ layoutPreset: 'PROFESSIONAL', isDefault: false });
    expect(got.find((t) => t.isDefault)?.templateName).toBe('Compact');
    expect(await list(old.admin)).toHaveLength(5);
    expect((await req(old.admin, 'DELETE', `/api/settings/invoice-templates/${row!.id}`)).statusCode).toBe(200);
    expect((await list(old.admin)).map((t) => t.templateName)).not.toContain('Professional Studio');
  });

  it('a real bill: JSON and PDF, WITH and WITHOUT GST, derived payments — and the bill is untouched', async () => {
    const proId = (await list(T.admin)).find((t) => t.templateName === 'Professional Studio')!.id;
    await req(T.admin, 'PUT', '/api/settings/print', { ...DEFAULT_PRINT_SETTINGS, bank, terms: 'Company terms apply.', accent: 'BLUE' });
    const billBefore = (await req(T.admin, 'GET', `/api/bills/${T.bill}`)).json().data;
    const grand = Number(billBefore.grandTotal);
    // 3000 received: 2000 against the bill, 1000 left as UNAPPLIED advance (not payment on this bill).
    const r = await req(T.admin, 'POST', '/api/receipts', { receiptDate: '2026-09-21', customerMobile: '9876500022', customerName: 'Pro Customer', paymentMode: 'CASH', accountId: T.cash, amount: 3000, allocations: [{ billId: T.bill, amount: 2000 }] });
    expect(r.statusCode, r.body).toBe(200);

    const inv = await req(T.reader, 'GET', `/api/bills/${T.bill}/invoice?templateId=${proId}`);
    expect(inv.statusCode, inv.body).toBe(200);
    const m = inv.json().data;
    expect(m.template.layoutPreset).toBe('PROFESSIONAL');
    const row = (label: string) => m.totals.find((t: { label: string }) => t.label === label)?.value;
    expect(row('Advance / Received')).toBe('2,000.00');
    expect(row('Balance Due')).toBe(`₹${(grand - 2000).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
    expect(row('Grand Total')).toBe(`₹${grand.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
    expect(JSON.stringify(m)).not.toMatch(BILL_TO);

    const pdf = await req(T.reader, 'GET', `/api/bills/${T.bill}/invoice/pdf?templateId=${proId}`);
    expect(pdf.statusCode).toBe(200);
    const text = (await pdfPages(pdf.rawPayload)).map((p) => p.text).join(' ');
    for (const s of ['TAX INVOICE', 'CUSTOMER', 'BILL DETAILS', 'GST%', 'Total in words', 'BANK DETAILS', 'Balance Due', 'Company terms apply.', 'Received By']) expect(text, s).toContain(s);
    expect(text).not.toMatch(BILL_TO);
    expect(text).not.toMatch(SHIP_TO);

    const ng = await req(T.reader, 'GET', `/api/bills/${T.noGst}/invoice/pdf?templateId=${proId}`);
    expect(ng.statusCode).toBe(200);
    const ngText = (await pdfPages(ng.rawPayload)).map((p) => p.text).join(' ');
    expect(ngText).not.toContain('GST%');
    expect(ngText).not.toContain('TAX INVOICE');

    const billAfter = (await req(T.admin, 'GET', `/api/bills/${T.bill}`)).json().data;
    expect({ ...billAfter, updatedAt: null }).toEqual({ ...billBefore, updatedAt: null });
    expect(billAfter.updatedAt).toBe(billBefore.updatedAt);
  });

  it('the public invoice link serves the same Professional Studio PDF', async () => {
    const proId = (await list(T.admin)).find((t) => t.templateName === 'Professional Studio')!.id;
    const link = await req(T.reader, 'POST', `/api/bills/${T.bill}/invoice/public-link`, { templateId: proId });
    expect(link.statusCode, link.body).toBe(200);
    const pub = await app.inject({ method: 'GET', url: new URL(link.json().data.url).pathname });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('application/pdf');
    const text = (await pdfPages(pub.rawPayload)).map((p) => p.text).join(' ');
    for (const s of ['CUSTOMER', 'BILL DETAILS', 'Balance Due']) expect(text).toContain(s);
    expect(text).not.toMatch(BILL_TO);
  });
});
