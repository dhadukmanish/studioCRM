import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildInvoiceModel,
  formatAmount,
  formatDecimal,
  invoiceFileName,
  invoiceTemplateConfigSchema,
  invoiceTemplateSchema,
  isTemplateCompatible,
  pickInvoiceTemplate,
  sampleInvoiceBill,
  starterInvoiceTemplates,
  type CompanyProfile,
  type InvoiceBillSource,
  type InvoiceRenderModel,
  type InvoiceTemplateConfig,
  type InvoiceTemplateSource,
} from '@erp/shared';
import { renderInvoicePdf } from '../services/invoicePdf';

/**
 * Invoice Template Master, the Invoice Render Model and the PDF.
 *
 * Section A is pure and always runs: the template schema, compatibility and fallback, the render
 * model (snapshot use, date format, GST / no-GST presentation, visibility and order), and real
 * PDFs rendered and parsed back — text extracted with pdf.js, pages counted, images found.
 * Section B needs TEST_DATABASE_URL: template CRUD rules, tenant isolation, RBAC, the invoice
 * endpoints, and that invoicing a bill changes nothing.
 */

/* ------------------------------------------------------------- fixtures -- */

const starters = starterInvoiceTemplates();
const classic = (): InvoiceTemplateSource => ({ id: 'tpl-classic', ...structuredClone(starters[0]) });
const withConfig = (patch: (c: InvoiceTemplateConfig) => void, base = classic()): InvoiceTemplateSource => {
  const t = structuredClone(base);
  patch(t.config);
  return t;
};

const company: CompanyProfile = {
  id: '00000000-0000-4000-8000-00000000c0de',
  name: 'Pratishtha Photo Studio',
  legalName: null,
  taxId: '24ABCDE1234F1Z5',
  email: 'hello@studio.test',
  phone: '98250 12345',
  website: null,
  addressLine1: '12, Shanti Complex',
  addressLine2: null,
  city: 'Rajkot',
  state: 'Gujarat',
  pincode: '360001',
  countryCode: 'IN',
  currency: 'INR',
  logo: { version: '1790310793107', contentType: 'image/png' },
};

/**
 * A saved bill whose SNAPSHOT differs from anything a master would say today — the model must
 * print these values, which is how "the invoice reads the bill, not Item Master" is proven.
 */
const savedBill = (over: Partial<InvoiceBillSource> = {}): InvoiceBillSource => ({
  bookNumber: '2026-27',
  billNumber: 7,
  billDate: '2026-09-25',
  deliveryDate: '2026-10-02',
  taxMode: 'WITH_GST',
  customerName: 'Maheshbhai Gangani',
  mobileNumber: '9601292221',
  babyName: 'Preet',
  hasBirthDate: true,
  birthDate: '2024-02-29',
  remark: 'Deliver album before Diwali',
  appointmentNumber: 3,
  discountType: 'PERCENT',
  discountValue: 10,
  discountAmount: 1250,
  subTotal: 12500,
  netTaxable: 11250,
  gstAmount: 1462.5,
  grandTotal: 12712.5,
  items: [
    { itemNameSnapshot: 'Photography (old name)', subItemNameSnapshot: 'Newborn Shoot', hsnCodeSnapshot: '998383', gstRateSnapshot: 12, quantity: 1, rate: 10000, grossTaxable: 10000, discountAllocated: 1000, taxableAmount: 9000, gstAmount: 1080, lineTotal: 10080, remark: null },
    { itemNameSnapshot: 'Album', subItemNameSnapshot: 'Album 12x36', hsnCodeSnapshot: '4911', gstRateSnapshot: 18, quantity: 2.5, rate: 1000, grossTaxable: 2500, discountAllocated: 250, taxableAmount: 2250, gstAmount: 382.5, lineTotal: 2632.5, remark: 'Matte' },
  ],
  gstSummary: [
    { gstRate: 12, taxableAmount: 9000, gstAmount: 1080 },
    { gstRate: 18, taxableAmount: 2250, gstAmount: 382.5 },
  ],
  ...over,
});
const noGstBill = () =>
  savedBill({
    taxMode: 'WITHOUT_GST',
    gstAmount: 0,
    grandTotal: 11250,
    items: savedBill().items.map((l) => ({ ...l, gstAmount: 0, lineTotal: l.taxableAmount })),
    gstSummary: [{ gstRate: 12, taxableAmount: 9000, gstAmount: 0 }, { gstRate: 18, taxableAmount: 2250, gstAmount: 0 }],
  });

const model = (over: { bill?: InvoiceBillSource; template?: InvoiceTemplateSource; dateFormat?: 'dd/MM/yyyy' | 'dd-MM-yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd'; company?: CompanyProfile | null } = {}) =>
  buildInvoiceModel({ bill: over.bill ?? savedBill(), company: over.company === undefined ? company : over.company, dateFormat: over.dateFormat ?? 'dd/MM/yyyy', template: over.template ?? classic() });
const field = (fields: { label: string; value: string }[], label: string) => fields.find((f) => f.label === label)?.value;
const col = (m: InvoiceRenderModel, key: string) => m.columns.findIndex((c) => c.key === key);

/* --------------------------------------------- A. template configuration -- */

describe('invoiceTemplateConfigSchema', () => {
  it.each(starters.map((s) => [s.templateName, s]))('accepts the %s starter', (_n, s) => {
    expect(invoiceTemplateConfigSchema.safeParse(s.config).success).toBe(true);
  });

  const bad = (patch: (c: Record<string, any>) => void) => {
    const c = structuredClone(starters[0].config) as Record<string, any>;
    patch(c);
    return invoiceTemplateConfigSchema.safeParse(c);
  };

  it.each([
    ['an unsupported column', (c: any) => (c.columns = ['serial', 'item', 'total', 'profitMargin'])],
    ['a duplicated column', (c: any) => (c.columns = ['item', 'item', 'total'])],
    ['no Total column', (c: any) => (c.columns = ['item', 'quantity'])],
    ['neither Item nor Product', (c: any) => (c.columns = ['quantity', 'total'])],
    ['no columns', (c: any) => (c.columns = [])],
    ['an invalid alignment', (c: any) => (c.header.alignment = 'JUSTIFY')],
    ['an invalid logo alignment', (c: any) => (c.header.logoAlignment = 'left')],
    ['a paper size other than A4', (c: any) => (c.page.paperSize = 'LETTER')],
    ['landscape', (c: any) => (c.page.orientation = 'LANDSCAPE')],
    ['oversized terms', (c: any) => (c.footer.terms = 'x'.repeat(1001))],
    ['an oversized title', (c: any) => (c.header.title = 'x'.repeat(41))],
    ['an empty title', (c: any) => (c.header.title = '   ')],
    ['a control character', (c: any) => (c.footer.thankYou = 'Thanks\u0007')],
    ['an unknown key (e.g. css)', (c: any) => (c.header.css = 'body{display:none}')],
    ['an unknown section (e.g. html)', (c: any) => (c.html = '<script>alert(1)</script>')],
    ['a string where a switch belongs', (c: any) => (c.totals.showDiscount = 'yes')],
    ['a missing section', (c: any) => delete c.footer],
  ])('refuses %s', (_label, patch) => {
    expect(bad(patch).success).toBe(false);
  });

  it('refuses a non-object config', () => {
    expect(invoiceTemplateConfigSchema.safeParse('{"header":{}}').success).toBe(false);
    expect(invoiceTemplateConfigSchema.safeParse(null).success).toBe(false);
  });

  it('keeps markup as plain text rather than refusing it — it is only ever drawn as text', () => {
    const r = invoiceTemplateConfigSchema.parse({ ...starters[0].config, footer: { ...starters[0].config.footer, terms: '<b>No refunds</b>' } });
    expect(r.footer.terms).toBe('<b>No refunds</b>');
  });

  it('keeps column order as given', () => {
    const r = invoiceTemplateConfigSchema.parse({ ...starters[0].config, columns: ['total', 'product', 'serial'] });
    expect(r.columns).toEqual(['total', 'product', 'serial']);
  });
});

describe('invoiceTemplateSchema (create / update body)', () => {
  const body = () => ({ templateName: 'Mine', supportedMode: 'BOTH', layoutPreset: 'CLASSIC', config: starters[0].config });
  it('accepts a valid body and drops isDefault — the default moves only through its own endpoint', () => {
    const r = invoiceTemplateSchema.parse({ ...body(), isDefault: true });
    expect(r).not.toHaveProperty('isDefault');
    expect(r.isActive).toBe(true);
  });
  it.each([['supportedMode', 'GST_ONLY'], ['layoutPreset', 'FANCY'], ['templateName', ''], ['templateName', 'x'.repeat(61)]])('refuses %s = %p', (k, v) => {
    expect(invoiceTemplateSchema.safeParse({ ...body(), [k]: v }).success).toBe(false);
  });
});

/* ------------------------------------------ A. compatibility and default -- */

describe('template compatibility and the default fallback', () => {
  const T = (id: string, name: string, supportedMode: 'BOTH' | 'WITH_GST' | 'WITHOUT_GST', isDefault = false, isActive = true) => ({ id, templateName: name, supportedMode, isDefault, isActive });

  it('BOTH fits either bill; a single-mode template fits only its own', () => {
    expect(isTemplateCompatible('BOTH', 'WITH_GST')).toBe(true);
    expect(isTemplateCompatible('BOTH', 'WITHOUT_GST')).toBe(true);
    expect(isTemplateCompatible('WITH_GST', 'WITH_GST')).toBe(true);
    expect(isTemplateCompatible('WITH_GST', 'WITHOUT_GST')).toBe(false);
    expect(isTemplateCompatible('WITHOUT_GST', 'WITH_GST')).toBe(false);
  });

  it('uses the default when it fits', () => {
    expect(pickInvoiceTemplate([T('a', 'Alpha', 'BOTH'), T('b', 'Beta', 'BOTH', true)], 'WITH_GST')?.id).toBe('b');
  });

  it('a WITH_GST-only default never renders a WITHOUT_GST bill: falls back to a compatible one, BOTH first', () => {
    const list = [T('d', 'Detailed', 'WITH_GST', true), T('n', 'Aaa No GST', 'WITHOUT_GST'), T('c', 'Classic', 'BOTH')];
    expect(pickInvoiceTemplate(list, 'WITHOUT_GST')?.id).toBe('c');
    expect(pickInvoiceTemplate(list, 'WITH_GST')?.id).toBe('d');
  });

  it('skips inactive templates, and ranks deterministically by name then id', () => {
    expect(pickInvoiceTemplate([T('z', 'Zed', 'BOTH'), T('y', 'Alpha', 'BOTH', false, false), T('x', 'Mid', 'BOTH')], 'WITH_GST')?.id).toBe('x');
    expect(pickInvoiceTemplate([T('b', 'Same', 'BOTH'), T('a', 'Same', 'BOTH')], 'WITH_GST')?.id).toBe('a');
  });

  it('returns null when nothing fits, so the caller uses the built-in Classic', () => {
    expect(pickInvoiceTemplate([T('d', 'Detailed', 'WITH_GST', true)], 'WITHOUT_GST')).toBeNull();
    expect(pickInvoiceTemplate([], 'WITH_GST')).toBeNull();
  });

  it('ships a BOTH-compatible default starter, so no bill is ever stranded', () => {
    expect(starters.filter((s) => s.isDefault)).toHaveLength(1);
    expect(starters.find((s) => s.isDefault)?.supportedMode).toBe('BOTH');
  });
});

/* --------------------------------------------------- A. the render model -- */

describe('buildInvoiceModel — a WITH_GST bill', () => {
  const m = model();

  it('carries the company from Company Settings and a logo reference, never the bytes', () => {
    expect(m.header.companyName).toBe('Pratishtha Photo Studio');
    expect(m.header.lines).toEqual(['12, Shanti Complex', 'Rajkot, Gujarat - 360001', 'Phone: 98250 12345   Email: hello@studio.test', 'GSTIN: 24ABCDE1234F1Z5']);
    expect(m.header.logo).toEqual({ companyId: company.id, version: company.logo!.version, contentType: 'image/png', alignment: 'LEFT' });
  });

  it('follows the global date format for every business date', () => {
    expect(field(m.meta, 'Bill Date')).toBe('25/09/2026');
    expect(field(m.meta, 'Delivery Date')).toBe('02/10/2026');
    expect(field(m.customer, 'Birth Date')).toBe('29/02/2024');
    expect(field(model({ dateFormat: 'MM/dd/yyyy' }).meta, 'Bill Date')).toBe('09/25/2026');
    expect(field(model({ dateFormat: 'dd-MM-yyyy' }).meta, 'Bill Date')).toBe('25-09-2026');
  });

  it('prints the bill’s own snapshot, not today’s masters', () => {
    expect(m.rows[0][col(m, 'item')]).toBe('Photography (old name)');
    expect(m.rows[0][col(m, 'gstRate')]).toBe('12%');
    expect(m.rows[1][col(m, 'quantity')]).toBe('2.5');
    expect(m.rows[1][col(m, 'taxable')]).toBe('2,250.00');
    expect(m.rows[1][col(m, 'total')]).toBe('2,632.50');
  });

  it('shows the bill’s stored totals — discount, taxable, GST and Grand Total — unchanged', () => {
    expect(m.totals).toEqual([
      { label: 'Sub Total', value: '12,500.00', strong: false },
      { label: 'Discount (10%)', value: '-1,250.00', strong: false },
      { label: 'Taxable Amount', value: '11,250.00', strong: false },
      { label: 'GST', value: '1,462.50', strong: false },
      { label: 'Grand Total', value: '₹12,712.50', strong: true },
    ]);
  });

  it('shows the Billing service’s rate-wise GST summary as it stands', () => {
    expect(m.gstSummary).toEqual({ columns: ['GST Rate', 'Taxable', 'GST'], rows: [['12%', '9,000.00', '1,080.00'], ['18%', '2,250.00', '382.50']], total: ['Total', '11,250.00', '1,462.50'] });
  });

  it('never calculates: a bill whose stored figures differ from qty x rate prints the stored figures', () => {
    const odd = savedBill({ grandTotal: 99999.99 });
    expect(model({ bill: odd }).totals.at(-1)?.value).toBe('₹99,999.99');
  });

  it('does not mutate the bill or the template it is given', () => {
    const bill = savedBill();
    const tpl = classic();
    const before = JSON.stringify([bill, tpl]);
    buildInvoiceModel({ bill: Object.freeze(bill), company, dateFormat: 'dd/MM/yyyy', template: Object.freeze(tpl) });
    expect(JSON.stringify([bill, tpl])).toBe(before);
  });

  it('identifies the invoice whatever the template hides', () => {
    const bare = model({ template: withConfig((c) => { c.customer = { showMobile: false, showBabyName: false, showBirthDate: false, showAppointmentReference: false, showDeliveryDate: false, showRemark: false }; c.totals = { showSubTotal: false, showDiscount: false, showTaxableTotal: false, showGstTotal: false, showGstSummary: false }; }) });
    expect(bare.meta.map((f) => f.label)).toEqual(['Bill No.', 'Book', 'Bill Date']);
    expect(bare.customer).toEqual([{ label: 'Customer', value: 'Maheshbhai Gangani', strong: true }]);
    expect(bare.totals).toEqual([{ label: 'Grand Total', value: '₹12,712.50', strong: true }]);
    expect(bare.gstSummary).toBeNull();
    expect(bare.remark).toBeNull();
  });
});

describe('buildInvoiceModel — a WITHOUT_GST bill does not present GST as charged', () => {
  const m = model({ bill: noGstBill() });
  it('uses the without-GST title', () => expect(m.title).toBe('Invoice'));
  it('drops GST %, GST and Taxable columns', () => expect(m.columns.map((c) => c.key)).toEqual(['serial', 'item', 'product', 'quantity', 'rate', 'total']));
  it('labels the line total as Amount', () => expect(m.columns.find((c) => c.key === 'total')?.label).toBe('Amount'));
  it('shows no GST or Taxable total and no GST summary', () => {
    expect(m.totals.map((t) => t.label)).toEqual(['Sub Total', 'Discount (10%)', 'Grand Total']);
    expect(m.gstSummary).toBeNull();
  });
  it('still totals to the bill’s own Grand Total', () => expect(m.totals.at(-1)?.value).toBe('₹11,250.00'));
  it('never prints the same figure twice: Amount (Qty x Rate) is dropped without a discount, and is "Gross" with one', () => {
    const tpl = withConfig((c) => (c.columns = ['serial', 'product', 'amount', 'total']));
    const plain = model({ bill: { ...noGstBill(), discountType: 'NONE', discountValue: 0, discountAmount: 0 }, template: tpl });
    expect(plain.columns.map((c) => c.label)).toEqual(['#', 'Product', 'Amount']);
    const discounted = model({ bill: noGstBill(), template: tpl });
    expect(discounted.columns.map((c) => c.label)).toEqual(['#', 'Product', 'Gross', 'Amount']);
  });
});

describe('buildInvoiceModel — template visibility and order', () => {
  it('follows the configured column order exactly', () => {
    const m = model({ template: withConfig((c) => (c.columns = ['total', 'gstAmount', 'product', 'serial'])) });
    expect(m.columns.map((c) => c.key)).toEqual(['total', 'gstAmount', 'product', 'serial']);
    expect(m.rows[0]).toEqual(['10,080.00', '1,080.00', 'Newborn Shoot', '1']);
  });

  it('hides each header detail the template turns off, and the logo too', () => {
    const m = model({ template: withConfig((c) => Object.assign(c.header, { showLogo: false, showCompanyAddress: false, showCompanyPhone: false, showCompanyEmail: false, showCompanyGstin: false })) });
    expect(m.header.logo).toBeNull();
    expect(m.header.lines).toEqual([]);
  });

  it('prints only the company details that exist', () => {
    const m = model({ company: { ...company, taxId: '', email: null, phone: null, addressLine1: null, city: null, state: null, pincode: null, logo: null } });
    expect(m.header.lines).toEqual([]);
    expect(m.header.logo).toBeNull();
    expect(m.header.companyName).toBe('Pratishtha Photo Studio');
  });

  it('works with no company profile at all', () => {
    const m = model({ company: null });
    expect(m.header.companyName).toBeNull();
    expect(m.footer.signatory).toBeNull();
  });

  it('hides a zero discount even when the template shows discounts', () => {
    const m = model({ bill: savedBill({ discountType: 'NONE', discountValue: 0, discountAmount: 0 }) });
    expect(m.totals.map((t) => t.label)).not.toContain('Discount');
  });

  it('writes a safe file name from book and bill number only', () => {
    expect(model().fileName).toBe('Invoice-2026-27-7.pdf');
    expect(invoiceFileName('A/B: "x"..', 3)).toBe('Invoice-A-B-x-3.pdf');
  });
});

describe('money and number formatting', () => {
  it.each([
    [0, '0.00'], [5, '5.00'], [999.9, '999.90'], [1000, '1,000.00'], [65625, '65,625.00'], [100000, '1,00,000.00'],
    [12345678.9, '1,23,45,678.90'], [0.1 + 0.2, '0.30'], [-1250, '-1,250.00'],
  ])('%p -> %p (Indian grouping)', (v, s) => expect(formatAmount(v)).toBe(s));
  it.each([[1, '1'], [2.5, '2.5'], [2.25, '2.25'], [18, '18'], [0.5, '0.5']])('%p -> %p', (v, s) => expect(formatDecimal(v)).toBe(s));
});

/* ----------------------------------------------------------- A. the PDF -- */

// A real 2x1 PNG, so the image path is exercised end to end.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGPgUv/PwMDAAAAIjAFR9P6TeAAAAABJRU5ErkJggg==', 'base64');

async function pdfText(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return pages;
}
const imageCount = (bytes: Uint8Array) => (Buffer.from(bytes).toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length;

/**
 * Which printed characters have NO drawable outline in the fonts the PDF actually embeds. A text
 * layer can be perfect while the page prints blank — exactly what pdf-lib's own subsetting did to
 * Noto Sans — so this opens every embedded font program and checks each character's glyph path.
 */
async function glyphsMissingOutlines(bytes: Uint8Array, printed: string) {
  const { PDFDocument, PDFDict, PDFRawStream, PDFName, decodePDFRawStream } = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const doc = await PDFDocument.load(bytes);
  const fonts: ReturnType<typeof fontkit.create>[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
    const file = doc.context.lookup(obj.get(PDFName.of('FontFile2')));
    if (!(file instanceof PDFRawStream)) continue;
    try {
      fonts.push(fontkit.create(Buffer.from(decodePDFRawStream(file).decode())));
    } catch {
      // A font program that cannot even be parsed draws nothing — its characters stay "missing".
    }
  }
  const drawable = (ch: string) =>
    fonts.some((f) => {
      try {
        const g = f.glyphForCodePoint(ch.codePointAt(0)!);
        return g.id !== 0 && (g.path as unknown as { commands: unknown[] }).commands.length > 0;
      } catch {
        return false; // a glyph the font cannot even produce is not drawable
      }
    });
  return { fonts: fonts.length, missing: [...new Set(printed.replace(/\s/g, ''))].filter((ch) => !drawable(ch)) };
}

describe('renderInvoicePdf', () => {
  it('produces a real PDF with the invoice as text', async () => {
    const bytes = await renderInvoicePdf(model(), { data: PNG, contentType: 'image/png' });
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
    const [page] = await pdfText(bytes);
    for (const s of ['Pratishtha Photo Studio', 'TAX INVOICE', 'GSTIN: 24ABCDE1234F1Z5', 'Maheshbhai Gangani', 'Preet', '25/09/2026', '29/02/2024', 'Photography (old name)', 'Discount (10%)', '-1,250.00', '1,462.50', '₹12,712.50', 'GST SUMMARY', 'Deliver album before Diwali', 'Authorised Signatory', 'Page 1 of 1']) {
      expect(page, s).toContain(s);
    }
  });

  it('every printed character has a real glyph outline in the embedded fonts (the page is not blank)', async () => {
    const bytes = await renderInvoicePdf(model({ bill: savedBill({ customerName: 'Zoë Émile — №7 “Dé”' }) }), null);
    const printed = (await pdfText(bytes)).join(' ');
    const { fonts, missing } = await glyphsMissingOutlines(bytes, printed);
    expect(fonts).toBe(2);
    expect(missing).toEqual([]);
  });

  it('that outline check really catches blank glyphs (negative control: pdf-lib’s own subsetting)', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const original = createRequire(import.meta.url).resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf');
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const f = await d.embedFont(readFileSync(original), { subset: true });
    d.addPage().drawText('ClickG TAX INVOICE', { x: 20, y: 700, size: 12, font: f });
    const bytes = await d.save();
    expect((await glyphsMissingOutlines(bytes, 'ClickG TAX INVOICE')).missing.length).toBeGreaterThan(0);
  });

  it('embeds the logo when there is one, and renders cleanly without it', async () => {
    expect(imageCount(await renderInvoicePdf(model(), { data: PNG, contentType: 'image/png' }))).toBe(1);
    expect(imageCount(await renderInvoicePdf(model({ company: { ...company, logo: null } }), null))).toBe(0);
    // A format pdf-lib cannot embed is skipped, not faked and not fatal.
    expect(imageCount(await renderInvoicePdf(model(), { data: new Uint8Array([1, 2, 3]), contentType: 'image/webp' }))).toBe(0);
  });

  it('a WITHOUT_GST bill prints no GST column, total or summary', async () => {
    const [page] = await pdfText(await renderInvoicePdf(model({ bill: noGstBill() }), null));
    expect(page).toContain('INVOICE');
    expect(page).not.toContain('TAX INVOICE');
    expect(page).not.toContain('GST SUMMARY');
    expect(page).not.toContain('GST %');
    expect(page).toContain('₹11,250.00');
  });

  it('paginates a long bill: header row repeated, no row lost, totals and footer on the last page', async () => {
    const line = savedBill().items[0];
    const items = Array.from({ length: 90 }, (_, i) => ({ ...line, subItemNameSnapshot: `Print ${i + 1}`, remark: i % 7 === 0 ? 'A remark long enough to wrap onto a second line in its narrow cell' : null }));
    const m = model({ bill: savedBill({ items }), template: withConfig((c) => { c.columns = [...c.columns, 'remark']; c.footer.showTerms = true; c.footer.terms = 'Line one\nLine two'; }) });
    const pages = await pdfText(await renderInvoicePdf(m, null));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p, i) => {
      expect(p).toContain('Product'); // the table header, on every page
      expect(p).toContain(`Page ${i + 1} of ${pages.length}`);
    });
    const all = pages.join(' ');
    for (let i = 1; i <= 90; i++) expect(all).toContain(`Print ${i} `);
    expect(pages.at(-1)).toContain('₹12,712.50');
    expect(pages.at(-1)).toContain('Line one Line two'); // two lines, not "Line oneLine two"
    expect(pages[0]).not.toContain('Grand Total');
  });

  /**
   * Regressions found by LOOKING at a 12-column invoice: figures broke across lines ("12,500." /
   * "00"), the "fi" ligature printed with a gap and extracted as a stray glyph, and terms lost
   * their line breaks.
   */
  it('on the widest table, never breaks a figure, a serial or an HSN across lines, and prints "fi" plainly', async () => {
    const detailed = starters.find((s) => s.templateName === 'Detailed GST')!;
    const items = Array.from({ length: 24 }, (_, i) => ({ ...savedBill().items[0], rate: 1250000, grossTaxable: 1250000, taxableAmount: 1187500, gstAmount: 213750, lineTotal: 1401250, subItemNameSnapshot: `Print ${i + 1} — Canvas 16x20`, remark: 'Matte finish, deliver with frame' }));
    const m = model({ bill: savedBill({ items }), template: { id: 't', ...structuredClone(detailed), config: { ...structuredClone(detailed.config), columns: [...detailed.config.columns, 'remark'] } } });
    const bytes = await renderInvoicePdf(m, null);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
    const runs: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) for (const it of (await (await doc.getPage(p)).getTextContent()).items) if ('str' in it && it.str.trim()) runs.push(it.str.trim());
    for (const figure of ['12,50,000.00', '11,87,500.00', '2,13,750.00', '14,01,250.00', '998383', '24']) expect(runs, figure).toContain(figure);
    expect(runs.filter((r) => /^\d{1,3}(,\d{2,3})*\.$|^\.?\d{1,2}$/.test(r) && r.endsWith('.'))).toEqual([]);
    expect(runs.join(' ')).toContain('Matte finish');
  });

  /** Every text run's baseline, per page, as pdf.js reports it — to prove nothing leaves the page. */
  async function baselines(bytes: Uint8Array) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
    const out: { page: number; y: number; str: string }[] = [];
    for (let p = 1; p <= doc.numPages; p++) for (const it of (await (await doc.getPage(p)).getTextContent()).items) if ('str' in it && it.str.trim()) out.push({ page: p, y: it.transform[5], str: it.str });
    return { pages: doc.numPages, runs: out };
  }

  it('a row taller than a page and terms longer than a page continue onto the next page — nothing is drawn off it', async () => {
    const huge = Array.from({ length: 260 }, (_, i) => `word${i}`).join(' ');
    const bill = savedBill({ items: [{ ...savedBill().items[0], remark: huge }, savedBill().items[1]] });
    const m = model({ bill, template: withConfig((c) => { c.columns = ['serial', 'product', 'remark', 'total']; c.footer.showTerms = true; c.footer.terms = Array.from({ length: 120 }, (_, i) => `Term line ${i}`).join('\n'); }) });
    const { pages, runs } = await baselines(await renderInvoicePdf(m, null));
    expect(pages).toBeGreaterThanOrEqual(3);
    const margin = m.style.margin;
    for (const r of runs) expect(r.y, `"${r.str}" on page ${r.page}`).toBeGreaterThanOrEqual(margin - 1);
    const all = runs.map((r) => r.str).join(' ');
    for (const w of ['word0', 'word130', 'word259', 'Term line 0', 'Term line 119']) expect(all).toContain(w);
  });

  it('wraps very long company, customer and item text instead of overflowing', async () => {
    const long = 'Extraordinarily Long Studio Name That Keeps Going Past The Width Of An A4 Page Easily';
    const bill = savedBill({ customerName: 'A'.repeat(90), items: [{ ...savedBill().items[0], subItemNameSnapshot: 'Supercalifragilisticexpialidocious'.repeat(4) }] });
    const pages = await pdfText(await renderInvoicePdf(model({ bill, company: { ...company, name: long } }), null));
    expect(pages).toHaveLength(1);
    expect(pages[0].replace(/\s+/g, '')).toContain(long.replace(/\s+/g, ''));
  });

  it('is deterministic: the same invoice renders to the same bytes', async () => {
    const at = new Date('2026-09-25T10:00:00Z');
    const a = await renderInvoicePdf(model(), { data: PNG, contentType: 'image/png' }, { date: at });
    const b = await renderInvoicePdf(model(), { data: PNG, contentType: 'image/png' }, { date: at });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('reports only characters no invoice font has — Gujarati, Hindi and ₹ are printable, Tamil and emoji are not', async () => {
    const { unprintableText } = await import('../services/invoicePdf');
    expect(unprintableText(model())).toEqual([]);
    expect(unprintableText(model({ bill: savedBill({ customerName: 'પ્રિયા હર્ષદભાઈ', babyName: 'आरव', remark: 'કુલ રકમ ₹65,625.00 — बिल' }) }))).toEqual([]);
    expect(unprintableText(model({ bill: savedBill({ customerName: 'தமிழ்', remark: 'Thanks 😀' }) }))).toEqual([
      { area: 'Customer', characters: ['த', 'ம', 'ி', 'ழ', '்'] },
      { area: 'Remark', characters: ['😀'] },
    ]);
  });

  it('refuses to render unprintable text instead of drawing boxes: a 422 that says what and where', async () => {
    const { AppError } = await import('../lib/errors');
    const err = await renderInvoicePdf(model({ bill: savedBill({ customerName: 'Ravi தமிழ்' }) }), null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'INVOICE_UNPRINTABLE_TEXT', statusCode: 422 });
    expect((err as Error).message).toContain('in Customer');
    expect((err as Error).message).toContain('English, Gujarati and Hindi');
    const line = await renderInvoicePdf(model({ bill: savedBill({ items: [{ ...savedBill().items[0], remark: '日本' }] }), template: withConfig((c) => { c.columns = [...c.columns, 'remark']; }) }), null).catch((e: unknown) => e);
    expect((line as Error).message).toMatch(/in Line 1, Remark/);
  });

  it('marks the designer sample as SAMPLE', async () => {
    const m = buildInvoiceModel({ bill: sampleInvoiceBill(), company, dateFormat: 'dd/MM/yyyy', template: classic(), isSample: true });
    const [page] = await pdfText(await renderInvoicePdf(m, null));
    expect(page).toContain('SAMPLE');
    expect(page).toContain('Sample Customer');
  });
});

/**
 * Gujarati and Hindi. HarfBuzz shapes them (conjuncts, reph, the pre-base િ / ि, mark positions);
 * the text must extract as the ORIGINAL string, and no drawn glyph may be blank. Renderer test
 * data only — none of it is ever written to a real bill.
 */
describe('invoice PDF — Gujarati and Hindi (HarfBuzz shaping)', () => {
  const GU = ['શ્રી ગણેશ ફોટો સ્ટુડિયો', 'પ્રિયા હર્ષદભાઈ', 'ક્ષિતિ દ્વારકા'];
  const HI = ['प्रिया शर्मा', 'कृष्ण क्षत्रिय', 'हिंदी'];
  const MIXED = ['ClickG Studio - સુરત', 'Invoice - बिल', 'કુલ રકમ ₹65,625.00'];

  /** Text per visual line: pdf.js items on one baseline, in order, joined as they come. */
  async function pdfLines(bytes: Uint8Array) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true }).promise;
    const pages: string[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const lines: { y: number; x: number; s: string }[][] = [];
      for (const it of (await (await doc.getPage(p)).getTextContent()).items) {
        if (!('str' in it) || !it.str) continue;
        const [x, y] = [it.transform[4], it.transform[5]];
        const row = lines.find((l) => Math.abs(l[0].y - y) < 3);
        if (row) row.push({ y, x, s: it.str });
        else lines.push([{ y, x, s: it.str }]);
      }
      // pdf.js puts its own space items between cells, so a table row reads "cell cell cell".
      pages.push(lines.sort((a, b) => b[0].y - a[0].y).map((l) => l.sort((a, b) => a.x - b.x).map((it) => it.s).join('').replace(/\s+/g, ' ').trim()));
    }
    return pages;
  }

  /** Glyphs the PDF draws as text whose outline is empty (would print blank) — the space glyph aside. */
  async function blankDrawnGlyphs(bytes: Uint8Array) {
    const { PDFDocument, PDFDict, PDFRawStream, PDFName, PDFArray, decodePDFRawStream } = await import('pdf-lib');
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const doc = await PDFDocument.load(bytes);
    const out: { font: string; blank: number[]; drawn: number }[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Subtype')) !== PDFName.of('CIDFontType2')) continue;
      const descriptor = doc.context.lookup(obj.get(PDFName.of('FontDescriptor')), PDFDict);
      const font = fontkit.create(Buffer.from(decodePDFRawStream(doc.context.lookup(descriptor.get(PDFName.of('FontFile2'))) as Parameters<typeof decodePDFRawStream>[0]).decode()));
      const map = decodePDFRawStream(doc.context.lookup(obj.get(PDFName.of('CIDToGIDMap'))) as Parameters<typeof decodePDFRawStream>[0]).decode();
      const widths = doc.context.lookup(obj.get(PDFName.of('W')), PDFArray);
      expect(widths).toBeTruthy();
      const space = font.glyphForCodePoint(0x20).id;
      const gids = Array.from({ length: map.length / 2 - 1 }, (_, i) => (map[(i + 1) * 2] << 8) | map[(i + 1) * 2 + 1]);
      const blank = gids.filter((g) => g === 0 || (g !== space && (font.getGlyph(g).path as unknown as { commands: unknown[] }).commands.length === 0));
      out.push({ font: font.postscriptName ?? '?', blank, drawn: gids.length });
    }
    return out;
  }

  const indicBill = () =>
    savedBill({
      customerName: 'પ્રિયા હર્ષદભાઈ',
      babyName: 'कृष्ण क्षत्रिय',
      remark: 'ક્ષિતિ દ્વારકા — हिंदी',
      items: [
        { ...savedBill().items[0], itemNameSnapshot: 'ફોટોગ્રાફી', subItemNameSnapshot: 'शिशु फोटो शूट', remark: 'પ્રિન્ટ મેટ' },
        { ...savedBill().items[1], itemNameSnapshot: 'Album', subItemNameSnapshot: 'Album 12x36 - સુરત', remark: 'Matte - बिल' },
      ],
    });
  const indicCompany: CompanyProfile = { ...company, name: 'શ્રી ગણેશ ફોટો સ્ટુડિયો', addressLine1: 'ClickG Studio - સુરત', addressLine2: 'प्रिया शर्मा मार्ग', city: 'સુરત' };
  const indicTemplate = () => withConfig((c) => { c.columns = [...c.columns, 'remark']; c.footer.showTerms = true; c.footer.terms = 'કુલ રકમ ₹65,625.00\nInvoice - बिल'; c.footer.thankYou = 'આભાર — धन्यवाद'; });

  it('shapes rather than maps characters: conjuncts ligate, the pre-base vowel sign is drawn first, reph moves after its consonant', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { PdfText } = await import('../services/invoicePdfText');
    const tx = await PdfText.create(await PDFDocument.create());
    const drawn = (s: string) => tx.shape(s, 'regular').runs.flatMap((r) => r.glyphs.filter((g) => g.gid !== r.font.space || g.ax > 0));
    const gid = (ch: string) => tx.shape(ch, 'regular').runs[0].glyphs[0].gid;
    expect(drawn('ક્ષ')).toHaveLength(1); // one conjunct glyph for three characters
    expect(drawn('क्ष')).toHaveLength(1);
    const ki = drawn('कि');
    expect(ki).toHaveLength(2);
    expect(ki[1].gid).toBe(gid('क')); // ि is drawn BEFORE क, although typed after it
    const gi = drawn('કિ');
    expect(gi[1].gid).toBe(gid('ક'));
    const rk = drawn('र्क');
    expect(rk[0].gid).toBe(gid('क')); // reph: र् is drawn as a mark over क, after it
    expect(rk[1].ax).toBe(0);
    // Marks are positioned (x/y offsets), not left at the pen.
    expect(tx.shape('कुं', 'regular').runs[0].glyphs.some((g) => g.dx !== 0 || g.dy !== 0)).toBe(true);
  });

  it('extracts every Gujarati, Hindi and mixed string as the original Unicode, in order', async () => {
    const [page] = await pdfLines(await renderInvoicePdf(model({ bill: indicBill(), company: indicCompany, template: indicTemplate() }), null));
    const text = page.join('\n');
    for (const s of ['શ્રી ગણેશ ફોટો સ્ટુડિયો', 'ClickG Studio - સુરત', 'प्रिया शर्मा मार्ग', 'પ્રિયા હર્ષદભાઈ', 'कृष्ण क्षत्रिय', 'ક્ષિતિ દ્વારકા — हिंदी', 'ફોટોગ્રાફી', 'शिशु फोटो शूट', 'પ્રિન્ટ મેટ', 'Album 12x36 - સુરત', 'Matte - बिल', 'કુલ રકમ ₹65,625.00', 'Invoice - बिल', 'આભાર — धन्यवाद', '₹12,712.50']) {
      expect(text, s).toContain(s);
    }
    // No stray character codes (an unmapped glyph extracts as a control character).
    expect(text).not.toMatch(/[\u0000-\u0008\u000e-\u001f]/);
  });

  it('extracts the reference strings exactly in both weights, with the spaces between words', async () => {
    const { PDFDocument, rgb } = await import('pdf-lib');
    const { PdfText } = await import('../services/invoicePdfText');
    const doc = await PDFDocument.create();
    const tx = await PdfText.create(doc);
    const page = doc.addPage([595, 842]);
    const all = [...GU, ...HI, ...MIXED, 'किं कीं कुं कूं र्क त्र ई ऐं', 'કિં કીં કું કૂં ર્ક ત્ર'];
    all.forEach((s, i) => { tx.draw(page, s, 20, 800 - i * 30, 12, 'regular', rgb(0, 0, 0)); tx.draw(page, s, 20, 450 - i * 30, 12, 'bold', rgb(0, 0, 0)); });
    tx.finish();
    const bytes = await doc.save();
    const [lines] = await pdfLines(bytes);
    expect(lines).toEqual([...all, ...all]);
    for (const f of await blankDrawnGlyphs(bytes)) expect(f.blank, f.font).toEqual([]);
  });

  it('draws no blank glyph: every glyph drawn as text has an outline', async () => {
    const bytes = await renderInvoicePdf(model({ bill: indicBill(), company: indicCompany, template: indicTemplate() }), null);
    const fonts = await blankDrawnGlyphs(bytes);
    expect(fonts.map((f) => f.font).sort()).toEqual(['NotoSans-Regular', 'NotoSans-SemiBold', 'NotoSansDevanagari-Regular', 'NotoSansGujarati-Regular', 'NotoSansGujarati-SemiBold'].sort());
    for (const f of fonts) expect(f.blank, f.font).toEqual([]);
  });

  it('embeds only the scripts an invoice uses: an English invoice carries no Indic font', async () => {
    const fonts = await blankDrawnGlyphs(await renderInvoicePdf(model(), null));
    expect(fonts.map((f) => f.font).sort()).toEqual(['NotoSans-Regular', 'NotoSans-SemiBold']);
  });

  it('wraps a long Gujarati or Hindi word only between clusters — never inside a conjunct or before a sign', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const { PdfText } = await import('../services/invoicePdfText');
    const tx = await PdfText.create(await PDFDocument.create());
    for (const word of ['ક્ષિતિદ્વારકાશ્રીગણેશફોટોસ્ટુડિયો', 'क्षत्रियप्रियाशर्माकृष्णहिंदीर्क']) {
      const pieces = tx.wrapParagraph(word, 10, 'regular', 30);
      expect(pieces.length).toBeGreaterThan(2);
      expect(pieces.join('')).toBe(word);
      for (const p of pieces.slice(1)) expect(p, p).not.toMatch(/^[\p{M}‌‍]/u); // never starts with a sign
      for (const p of pieces.slice(0, -1)) expect(p, p).not.toMatch(/[्્]$/u); // never ends on a virama
      for (const p of pieces) if (tx.width(p, 10, 'regular') > 30) expect([...new Intl.Segmenter().segment(p)]).toHaveLength(1);
    }
    // Words still break at spaces first.
    expect(tx.wrapParagraph('પ્રિયા હર્ષદભાઈ प्रिया शर्मा', 10, 'regular', 70)).toEqual(['પ્રિયા હર્ષદભાઈ', 'प्रिया शर्मा']);
  });

  it('paginates a long Gujarati/Hindi bill: header on every page, every row once, totals and "Page x of y"', async () => {
    const line = savedBill().items[0];
    const items = Array.from({ length: 70 }, (_, i) => ({ ...line, subItemNameSnapshot: `ફોટો ${i + 1} प्रिंट`, remark: i % 5 === 0 ? 'ક્ષિતિ દ્વારકા પ્રિયા હર્ષદભાઈ कृष्ण क्षत्रिय प्रिया शर्मा हिंदी' : null }));
    const m = model({ bill: savedBill({ items }), company: indicCompany, template: indicTemplate() });
    const pages = await pdfLines(await renderInvoicePdf(m, null));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p, i) => {
      // The header row, on every page the rows continue onto (the last page may hold only the footer).
      if (p.some((l) => l.includes('प्रिंट'))) expect(p.join('\n'), `page ${i + 1}`).toContain('Product');
      expect(p.join('\n')).toContain(`Page ${i + 1} of ${pages.length}`);
    });
    const all = pages.map((p) => p.join('\n')).join('\n');
    for (let i = 1; i <= 70; i++) expect(all.split(`ફોટો ${i} प्रिंट`).length - 1, `row ${i}`).toBe(1);
    // The totals come once, after the last row; the thank-you note closes the last page.
    const lastRowPage = pages.findIndex((p) => p.join('\n').includes('ફોટો 70 प्रिंट'));
    const totalsPage = pages.findIndex((p) => p.join('\n').includes('₹12,712.50'));
    expect(all.split('₹12,712.50').length - 1).toBe(1);
    expect(totalsPage).toBeGreaterThanOrEqual(lastRowPage);
    expect(pages.at(-1)!.join('\n')).toContain('આભાર — धन्यवाद');
  });

  it('WITHOUT_GST in Gujarati/Hindi still shows no GST column, total or summary', async () => {
    const bill = { ...noGstBill(), customerName: 'પ્રિયા હર્ષદભાઈ', babyName: 'हिंदी' };
    const text = (await pdfLines(await renderInvoicePdf(model({ bill, company: indicCompany }), null)))[0].join('\n');
    expect(text).toContain('પ્રિયા હર્ષદભાઈ');
    expect(text).toContain('₹11,250.00');
    for (const gst of ['TAX INVOICE', 'GST SUMMARY', 'GST %']) expect(text).not.toContain(gst);
  });

  it('is deterministic with Indic text too', async () => {
    const at = new Date('2026-09-25T10:00:00Z');
    const m = model({ bill: indicBill(), company: indicCompany, template: indicTemplate() });
    const a = await renderInvoicePdf(m, null, { date: at });
    const b = await renderInvoicePdf(m, null, { date: at });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

/* ------------------------------------------ B. database-backed behaviour -- */

const TEST_DB = process.env.TEST_DATABASE_URL;

/**
 * Point it at a THROWAWAY database only — it creates and deletes tenants, templates and bills.
 *   TEST_DATABASE_URL=postgres://... pnpm --filter @erp/api test
 */
describe.skipIf(!TEST_DB)('Invoice templates and invoices API (integration, needs TEST_DATABASE_URL)', () => {
  type App = Awaited<ReturnType<typeof import('../server').buildApp>>;
  let app: App;
  let db: typeof import('../db/client').db;
  let sqlClient: typeof import('../db/client').sql;
  let schema: typeof import('../db/client').schema;
  let inArray: typeof import('drizzle-orm').inArray;
  let eq: typeof import('drizzle-orm').eq;

  const tenantIds: string[] = [];
  const A = { tenantId: '', admin: '', billingOnly: '', templatesRead: '', billId: '', noGstBillId: '', bookId: '', itemId: '' };
  const B = { tenantId: '', admin: '', billId: '', templateId: '' };
  const FULL = { operations_billing: ['read', 'create', 'update', 'delete'], settings_invoice_templates: ['read', 'create', 'update', 'delete'], masters_items: ['read', 'update'] };

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const req = (t: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: auth(t), payload });
  const templates = async (t: string) => (await req(t, 'GET', '/api/settings/invoice-templates')).json().data.rows as { id: string; templateName: string; isDefault: boolean; supportedMode: string; isActive: boolean; config: InvoiceTemplateConfig }[];
  const body = (name: string, over: Record<string, unknown> = {}) => ({ templateName: name, supportedMode: 'BOTH', layoutPreset: 'CLASSIC', config: starters[0].config, ...over });

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
    const admin = await user(FULL);
    const bill = async (taxMode: 'WITH_GST' | 'WITHOUT_GST') =>
      (await req(admin, 'POST', '/api/bills', { bookId: book.id, billDate: '2026-09-25', customerName: 'Invoice Customer', mobileNumber: '9876543210', taxMode, discountType: 'PERCENT', discountValue: 10, items: [{ itemId: item.id, subItemId: sub.id, quantity: 1, rate: 10000 }] })).json().data.id as string;
    return { tenantId: tenant.id, admin, user, bookId: book.id, itemId: item.id, bill };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.PORT = '0';
    ({ inArray, eq } = await import('drizzle-orm'));
    const client = await import('../db/client');
    ({ db, sql: sqlClient, schema } = client);
    app = await (await import('../server')).buildApp();
    await app.ready();
    const a = await seedTenant('inv-a');
    Object.assign(A, { tenantId: a.tenantId, admin: a.admin, bookId: a.bookId, itemId: a.itemId, billId: await a.bill('WITH_GST'), noGstBillId: await a.bill('WITHOUT_GST') });
    A.billingOnly = await a.user({ operations_billing: ['read'] });
    A.templatesRead = await a.user({ settings_invoice_templates: ['read'] });
    const b = await seedTenant('inv-b');
    Object.assign(B, { tenantId: b.tenantId, admin: b.admin, billId: await b.bill('WITH_GST') });
    B.templateId = (await templates(B.admin))[0].id;
  });

  afterAll(async () => {
    if (tenantIds.length) {
      for (const t of [schema.billItems, schema.bills, schema.subItems, schema.items, schema.books, schema.invoiceTemplates, schema.companyLogos, schema.branches, schema.companies, schema.appSettings, schema.activityLogs, schema.users, schema.roles] as const) {
        await db.delete(t).where(inArray((t as any).tenantId, tenantIds));
      }
      await db.delete(schema.tenants).where(inArray(schema.tenants.id, tenantIds));
    }
    await app?.close();
    await sqlClient?.end();
  });

  describe('templates', () => {
    it('a tenant starts with the three starters and exactly one (BOTH) default — seeded once', async () => {
      const list = await templates(A.admin);
      expect(list.map((t) => t.templateName).sort()).toEqual(['Classic', 'Compact', 'Detailed GST']);
      expect(list.filter((t) => t.isDefault)).toHaveLength(1);
      expect(list.find((t) => t.isDefault)?.supportedMode).toBe('BOTH');
      expect(await templates(A.admin)).toHaveLength(3);
    });

    it('creates, edits and duplicates; a copy is never the default', async () => {
      const created = (await req(A.admin, 'POST', '/api/settings/invoice-templates', body('Studio Special'))).json().data;
      expect(created.isDefault).toBe(false);
      const edited = await req(A.admin, 'PUT', `/api/settings/invoice-templates/${created.id}`, body('Studio Special', { layoutPreset: 'COMPACT' }));
      expect(edited.json().data.layoutPreset).toBe('COMPACT');
      const copy = (await req(A.admin, 'POST', `/api/settings/invoice-templates/${created.id}/duplicate`)).json().data;
      expect(copy).toMatchObject({ templateName: 'Studio Special Copy', isDefault: false, layoutPreset: 'COMPACT' });
      expect(copy.id).not.toBe(created.id);
      expect((await req(A.admin, 'POST', `/api/settings/invoice-templates/${created.id}/duplicate`)).json().data.templateName).toBe('Studio Special Copy 2');
    });

    it('refuses a duplicate name, case-insensitively', async () => {
      expect((await req(A.admin, 'POST', '/api/settings/invoice-templates', body('classic'))).statusCode).toBe(400);
    });

    it('refuses an invalid configuration at the API', async () => {
      const res = await req(A.admin, 'POST', '/api/settings/invoice-templates', body('Bad', { config: { ...starters[0].config, columns: ['item', 'total', 'secretColumn'] } }));
      expect(res.statusCode).toBe(400);
    });

    it('moving the default leaves exactly one default', async () => {
      const compact = (await templates(A.admin)).find((t) => t.templateName === 'Compact')!;
      expect((await req(A.admin, 'POST', `/api/settings/invoice-templates/${compact.id}/default`)).statusCode).toBe(200);
      const list = await templates(A.admin);
      expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([compact.id]);
      const classicT = list.find((t) => t.templateName === 'Classic')!;
      await req(A.admin, 'POST', `/api/settings/invoice-templates/${classicT.id}/default`);
    });

    it('the default cannot be deleted or deactivated; another template can be deleted', async () => {
      const list = await templates(A.admin);
      const def = list.find((t) => t.isDefault)!;
      expect((await req(A.admin, 'DELETE', `/api/settings/invoice-templates/${def.id}`)).statusCode).toBe(400);
      expect((await req(A.admin, 'PUT', `/api/settings/invoice-templates/${def.id}`, body(def.templateName, { isActive: false }))).statusCode).toBe(400);
      const spare = (await req(A.admin, 'POST', '/api/settings/invoice-templates', body('Spare'))).json().data;
      expect((await req(A.admin, 'DELETE', `/api/settings/invoice-templates/${spare.id}`)).statusCode).toBe(200);
      expect((await req(A.admin, 'GET', `/api/bills/${A.billId}`)).statusCode).toBe(200);
    });

    it('is tenant-isolated: another tenant’s template is not found for read, edit, default, duplicate or delete', async () => {
      for (const [m, u] of [['GET', ''], ['PUT', ''], ['POST', '/default'], ['POST', '/duplicate'], ['DELETE', '']] as const) {
        const res = await req(A.admin, m, `/api/settings/invoice-templates/${B.templateId}${u}`, m === 'PUT' ? body('Hijack') : undefined);
        expect(res.statusCode, `${m} ${u}`).toBe(404);
      }
      expect((await templates(A.admin)).some((t) => t.id === B.templateId)).toBe(false);
    });

    it('needs settings_invoice_templates to manage; read-only may not change', async () => {
      expect((await req(A.billingOnly, 'GET', '/api/settings/invoice-templates')).statusCode).toBe(403);
      expect((await req(A.templatesRead, 'POST', '/api/settings/invoice-templates', body('Nope'))).statusCode).toBe(403);
      expect((await req(A.templatesRead, 'GET', '/api/settings/invoice-templates')).statusCode).toBe(200);
    });
  });

  describe('invoice of a saved bill', () => {
    it('a billing user can preview it without any template permission', async () => {
      const res = await req(A.billingOnly, 'GET', `/api/bills/${A.billId}/invoice`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ taxMode: 'WITH_GST', title: 'Tax Invoice', template: { name: 'Classic' } });
    });

    it('a WITHOUT_GST bill falls back from a WITH_GST-only choice: an explicit incompatible template is refused', async () => {
      const detailed = (await templates(A.admin)).find((t) => t.templateName === 'Detailed GST')!;
      expect((await req(A.admin, 'GET', `/api/bills/${A.noGstBillId}/invoice?templateId=${detailed.id}`)).statusCode).toBe(400);
      expect((await req(A.admin, 'GET', `/api/bills/${A.noGstBillId}/invoice`)).json().data.template.name).toBe('Classic');
    });

    it('previewing with another template does not change the default', async () => {
      const compact = (await templates(A.admin)).find((t) => t.templateName === 'Compact')!;
      expect((await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice?templateId=${compact.id}`)).json().data.template.name).toBe('Compact');
      expect((await templates(A.admin)).find((t) => t.isDefault)?.templateName).toBe('Classic');
    });

    it('the PDF: content type, file name, real PDF', async () => {
      const res = await req(A.billingOnly, 'GET', `/api/bills/${A.billId}/invoice/pdf?download=1`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="Invoice-2026-27-1.pdf"');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
      const [page] = await pdfText(res.rawPayload);
      expect(page).toContain('Invoice Customer');
    });

    it('is blocked across tenants — bill and template alike', async () => {
      expect((await req(A.admin, 'GET', `/api/bills/${B.billId}/invoice`)).statusCode).toBe(404);
      expect((await req(A.admin, 'GET', `/api/bills/${B.billId}/invoice/pdf`)).statusCode).toBe(404);
      expect((await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice?templateId=${B.templateId}`)).statusCode).toBe(404);
    });

    it('needs a session and operations_billing', async () => {
      expect((await app.inject({ method: 'GET', url: `/api/bills/${A.billId}/invoice/pdf` })).statusCode).toBe(401);
      expect((await req(A.templatesRead, 'GET', `/api/bills/${A.billId}/invoice`)).statusCode).toBe(403);
    });

    it('changes nothing: bill, lines and the book counter are identical after preview and PDF', async () => {
      const snap = async () => JSON.stringify([
        await db.select().from(schema.bills).where(eq(schema.bills.id, A.billId)),
        await db.select().from(schema.billItems).where(eq(schema.billItems.billId, A.billId)),
        await db.select({ n: schema.books.nextBillNumber }).from(schema.books).where(eq(schema.books.id, A.bookId)),
      ]);
      const before = await snap();
      await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice`);
      await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice/pdf`);
      expect(await snap()).toBe(before);
    });

    it('an Item Master change afterwards does not alter the old invoice', async () => {
      const before = (await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice`)).json().data;
      await db.update(schema.items).set({ itemName: 'Renamed Today', gstRate: '28.00' }).where(eq(schema.items.id, A.itemId));
      const after = (await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice`)).json().data;
      expect(after.rows).toEqual(before.rows);
      expect(after.totals).toEqual(before.totals);
    });
  });

  /** WhatsApp sharing (docs/WHATSAPP_SHARING.md): the same read permission and tenant scope as the PDF. */
  describe('WhatsApp share', () => {
    const MISSING = '00000000-0000-4000-8000-000000000000';

    it('opens with the bill’s SAVED mobile, customer and stored Grand Total, and the company from Company Settings', async () => {
      const res = await req(A.billingOnly, 'GET', `/api/bills/${A.billId}/invoice/share`);
      expect(res.statusCode).toBe(200);
      const ctx = res.json().data;
      const invoice = (await req(A.billingOnly, 'GET', `/api/bills/${A.billId}/invoice`)).json().data;
      expect(ctx).toMatchObject({ transport: 'WHATSAPP_CLICK_TO_CHAT', customerName: 'Invoice Customer', mobileNumber: '9876543210', taxMode: 'WITH_GST', fileName: 'Invoice-2026-27-1.pdf' });
      expect(ctx.grandTotal).toBe(invoice.totals.at(-1).value);
      expect(ctx.message).toContain('2026-27/1');
      expect(ctx.message).toContain(ctx.grandTotal);
      expect(ctx.message).toContain('inv-a Studio');
    });

    it('uses the tenant’s own message, and refuses an unknown placeholder in it', async () => {
      const settingsAdmin = await (async () => {
        const [role] = await db.insert(schema.roles).values({ tenantId: A.tenantId, name: `settings ${Date.now()}`, permissions: { settings_general: ['read', 'update'] } }).returning();
        const [u] = await db.insert(schema.users).values({ tenantId: A.tenantId, roleId: role.id, firstName: 'S', lastName: 'T', email: `s-${Date.now()}@test.local`, passwordHash: 'x' }).returning();
        return app.jwt.sign({ sub: u.id, tenantId: A.tenantId });
      })();
      expect((await req(settingsAdmin, 'PUT', '/api/settings', { whatsappInvoiceMessage: 'Hi {Customer}' })).statusCode).toBe(400);
      expect((await req(settingsAdmin, 'PUT', '/api/settings', { whatsappInvoiceMessage: 'નમસ્તે {CustomerName} — बिल {BookNumber}/{BillNumber}, {GrandTotal}' })).statusCode).toBe(200);
      expect((await req(A.billingOnly, 'GET', `/api/bills/${A.billId}/invoice/share`)).json().data.message).toMatch(/^નમસ્તે Invoice Customer — बिल 2026-27\/1, ₹/);
      // Tenant B's message is its own.
      expect((await req(B.admin, 'GET', `/api/bills/${B.billId}/invoice/share`)).json().data.message.startsWith('Hello Invoice Customer,')).toBe(true);
    });

    it('records "WhatsApp opened" — never "sent" — with the template, and no number or message', async () => {
      const res = await req(A.billingOnly, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, { transport: 'WHATSAPP_CLICK_TO_CHAT' });
      expect(res.statusCode).toBe(200);
      const [log] = await db.select().from(schema.activityLogs).where(eq(schema.activityLogs.entityId, A.billId)).orderBy(schema.activityLogs.createdAt);
      expect(log).toMatchObject({ tenantId: A.tenantId, entityType: 'bill', action: 'whatsapp_share_opened' });
      expect(log.action).not.toMatch(/sent|deliver|read/i);
      expect(log.meta).toMatchObject({ transport: 'WHATSAPP_CLICK_TO_CHAT', templateName: 'Classic' });
      expect(JSON.stringify(log.meta)).not.toContain('9876543210');
      // The body may not carry the number or the text.
      expect((await req(A.billingOnly, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, { mobileNumber: '9876543210' })).statusCode).toBe(400);
    });

    it('refuses an incompatible, foreign or malformed template, like the PDF does', async () => {
      const detailed = (await templates(A.admin)).find((t) => t.templateName === 'Detailed GST')!;
      expect((await req(A.admin, 'POST', `/api/bills/${A.noGstBillId}/invoice/share-opened`, { templateId: detailed.id })).statusCode).toBe(400);
      expect((await req(A.admin, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, { templateId: B.templateId })).statusCode).toBe(404);
      expect((await req(A.admin, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, { templateId: 'not-a-uuid' })).statusCode).toBe(400);
    });

    it('is blocked across tenants, for a missing bill, without a session and without operations_billing', async () => {
      expect((await req(A.admin, 'GET', `/api/bills/${B.billId}/invoice/share`)).statusCode).toBe(404);
      expect((await req(A.admin, 'POST', `/api/bills/${B.billId}/invoice/share-opened`, {})).statusCode).toBe(404);
      expect((await req(A.admin, 'GET', `/api/bills/${MISSING}/invoice/share`)).statusCode).toBe(404);
      expect((await req(A.admin, 'GET', '/api/bills/not-a-uuid/invoice/share')).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/bills/${A.billId}/invoice/share` })).statusCode).toBe(401);
      expect((await req(A.templatesRead, 'GET', `/api/bills/${A.billId}/invoice/share`)).statusCode).toBe(403);
      expect((await req(A.templatesRead, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, {})).statusCode).toBe(403);
    });

    it('changes nothing but the audit log: bill, lines, GST, discount, total, book counter and default template are identical', async () => {
      const snap = async () => JSON.stringify([
        await db.select().from(schema.bills).where(eq(schema.bills.id, A.billId)),
        await db.select().from(schema.billItems).where(eq(schema.billItems.billId, A.billId)),
        await db.select({ n: schema.books.nextBillNumber }).from(schema.books).where(eq(schema.books.id, A.bookId)),
        await db.select().from(schema.documentCounters).where(eq(schema.documentCounters.tenantId, A.tenantId)),
        (await templates(A.admin)).map((t) => [t.templateName, t.isDefault, t.isActive]),
      ]);
      const before = await snap();
      const compact = (await templates(A.admin)).find((t) => t.templateName === 'Compact')!;
      await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice/share`);
      await req(A.admin, 'GET', `/api/bills/${A.billId}/invoice/pdf?templateId=${compact.id}`);
      await req(A.admin, 'POST', `/api/bills/${A.billId}/invoice/share-opened`, { templateId: compact.id });
      expect(await snap()).toBe(before);
    });
  });
});
