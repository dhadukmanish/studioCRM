/**
 * The Invoice Render Model — one read-only, display-ready description of an invoice, built by
 * ONE function and drawn by two renderers: the browser preview (React) and the PDF (pdf-lib).
 * Everything a renderer needs is decided here — which sections and columns exist, their order,
 * every label and every already-formatted value — so the two outputs cannot disagree about
 * content, visibility or order. See docs/INVOICE_TEMPLATES.md.
 *
 * It never calculates money. Every figure is read from the saved bill (its own snapshot and its
 * server-computed totals) and only FORMATTED here. The sample bill the designer previews is the
 * one exception, and it is built with the same shared `calculateBill` the API uses.
 */
import { calculateBill, type GstSummaryRow } from './billing.js';
import { formatDateOnly, type DateFormat } from './dates.js';
import {
  INVOICE_COLUMN_LABELS,
  INVOICE_COPY_LABEL_TEXT,
  type BillDiscountType,
  type InvoiceColumn,
  type InvoiceCopyLabel,
  type InvoiceDensity,
  type InvoiceLayoutPreset,
  type InvoiceMargin,
  type InvoicePaperSize,
  type InvoiceTaxMode,
  type InvoiceTemplateMode,
  type InvoiceAlignment,
} from './enums.js';
import type { CompanyProfile } from './schemas/org.js';
import type { InvoiceTemplateConfig } from './schemas/invoiceTemplates.js';
import { DEFAULT_PRINT_SETTINGS, INVOICE_ACCENT_COLORS, type PrintSettings } from './schemas/printSettings.js';

/* ------------------------------------------------------------- inputs -- */

/** The saved bill, as `getBill` returns it. Only snapshot fields — nothing is looked up in a master. */
export interface InvoiceBillSource {
  bookNumber: string;
  billNumber: number;
  billDate: string;
  deliveryDate: string | null;
  taxMode: InvoiceTaxMode;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  hasBirthDate: boolean;
  birthDate: string | null;
  remark: string | null;
  appointmentNumber: number | null;
  discountType: BillDiscountType;
  discountValue: number;
  discountAmount: number;
  subTotal: number;
  netTaxable: number;
  gstAmount: number;
  grandTotal: number;
  items: {
    itemNameSnapshot: string;
    subItemNameSnapshot: string;
    hsnCodeSnapshot: string | null;
    gstRateSnapshot: number;
    quantity: number;
    rate: number;
    grossTaxable: number;
    discountAllocated: number;
    taxableAmount: number;
    gstAmount: number;
    lineTotal: number;
    remark: string | null;
  }[];
  gstSummary: GstSummaryRow[];
}

export interface InvoiceTemplateSource {
  /** null for the built-in fallback, which is not a stored row. */
  id: string | null;
  templateName: string;
  supportedMode: InvoiceTemplateMode;
  layoutPreset: InvoiceLayoutPreset;
  config: InvoiceTemplateConfig;
}

/* ------------------------------------------------------------- output -- */

/** `strong` marks the field that identifies its block (the customer name, the bill number). */
export interface InvoiceField { label: string; value: string; strong?: boolean }
export type InvoiceCellAlign = 'left' | 'center' | 'right';
/**
 * `wrap: false` columns (numbers, serial, HSN) take their natural width and never break a value
 * across lines; only `wrap: true` text columns share the remaining width, by `weight`.
 */
export interface InvoiceColumnModel { key: InvoiceColumn; label: string; align: InvoiceCellAlign; weight: number; wrap: boolean }

/** Where a renderer fetches a company image from (logo / signature / footer image) — a reference, never a URL. */
export interface InvoiceImageRef { companyId: string; version: string; contentType: string }

/**
 * A bill's DERIVED payment position, read by the invoice service from `services/billPayments.ts`
 * (active receipt allocations + active advance applications). The model only formats it.
 */
export interface InvoicePayments { paid: number; outstanding: number }

export interface InvoiceRenderModel {
  /** True only for the designer's in-memory sample — renderers mark it as SAMPLE. */
  isSample: boolean;
  template: { id: string | null; name: string; layoutPreset: InvoiceLayoutPreset; supportedMode: InvoiceTemplateMode };
  taxMode: InvoiceTaxMode;
  title: string;
  style: InvoiceStyle;
  header: {
    alignment: InvoiceAlignment;
    /** Where to fetch the logo from (the company-logo service); the renderer never trusts a URL here. */
    logo: (InvoiceImageRef & { alignment: InvoiceAlignment }) | null;
    companyName: string | null;
    lines: string[];
  };
  /** "Original" / "Duplicate" / "Office Copy" — print metadata, top right. null = none. */
  copyLabel: string | null;
  /** The accent (hex) for rules and headings — dark and print-safe (INVOICE_ACCENT_COLORS). */
  accent: string;
  /** Every fixed heading both renderers print — defined once, here. */
  labels: { billedTo: string; details: string; gstSummary: string; remark: string; terms: string; signatoryCaption: string; bank: string; note: string; receivedBy: string; amountInWords: string };
  meta: InvoiceField[];
  customer: InvoiceField[];
  columns: InvoiceColumnModel[];
  /** One row per bill line, one formatted cell per column. */
  rows: string[][];
  /** `strong` = Grand Total (ruled above); `bold` = emphasised without a rule (Balance Due). */
  totals: { label: string; value: string; strong: boolean; bold?: boolean }[];
  /** "Rupees Twelve Thousand … Only" for the stored Grand Total, or null. */
  amountInWords: string | null;
  gstSummary: { columns: string[]; rows: string[][]; total: string[] } | null;
  remark: string | null;
  footer: {
    terms: string | null;
    thankYou: string | null;
    signatory: string | null;
    /** Print & Invoice settings: the invoice note, a one-line footer text, bank details (only the ones that exist). */
    note: string | null;
    text: string | null;
    bank: InvoiceField[] | null;
    /** A blank line for the customer's handwritten "Received By" — nothing is filled in. */
    receivedBy: boolean;
    /** Drawn above the signatory line when the company has one and the settings show it. */
    signatureImage: InvoiceImageRef | null;
    /** Optional graphic at the lower left (terms graphic, brand mark…). */
    footerImage: InvoiceImageRef | null;
  };
  /** "Page x of y" in the PDF page footer. */
  showPageNumbers: boolean;
  /** "2026-27 / 1" — printed in every PDF page footer. */
  documentLabel: string;
  fileName: string;
}

/* ------------------------------------------------------------- style --- */

/**
 * The fixed typography and spacing of each preset, in PDF points (1/72 in). The PDF uses them
 * as-is; the browser preview draws the A4 sheet in the same units, so both come out alike.
 */
export interface InvoiceStyle {
  preset: InvoiceLayoutPreset;
  paperSize: InvoicePaperSize;
  /**
   * STACKED: logo row, then the company block (Classic / Compact / Detailed).
   * SIDE: logo at the left, the company block beside it, copy label and title opposite (Studio).
   */
  headerLayout: 'STACKED' | 'SIDE';
  pageWidth: number;
  pageHeight: number;
  margin: number;
  fontSize: number;
  smallSize: number;
  titleSize: number;
  companySize: number;
  cellPadX: number;
  cellPadY: number;
  sectionGap: number;
  /** 'grid' draws every cell border; 'rows' draws only horizontal rules. */
  tableBorders: 'grid' | 'rows';
  headerFill: boolean;
  logoMaxHeight: number;
  logoMaxWidth: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Width of the label column in the Billed To / Invoice Details blocks. */
  customerLabelWidth: number;
  metaLabelWidth: number;
  /** Width of the totals block at the right of the summary band. */
  totalsWidth: number;
  /** The GST summary's three columns (rate, taxable, GST) as fractions of its width. */
  summaryColumns: [number, number, number];
  /** Length of the signature line above "Authorised Signatory". */
  signatureLineWidth: number;
}

/** The only colours an invoice uses. A business document ignores the app theme on purpose. */
export const INVOICE_COLORS = { paper: '#FFFFFF', text: '#111827', muted: '#4B5563', line: '#D1D5DB', rule: '#111827', headFill: '#F3F4F6', sample: '#DC2626' } as const;

const PAPER: Record<InvoicePaperSize, { width: number; height: number }> = { A4: { width: 595.28, height: 841.89 }, A5: { width: 419.53, height: 595.28 } };
const MARGIN: Record<InvoicePaperSize, Record<InvoiceMargin, number>> = { A4: { NARROW: 24, NORMAL: 36 }, A5: { NARROW: 18, NORMAL: 24 } };

export function invoiceStyle(preset: InvoiceLayoutPreset, margins: InvoiceMargin, density: InvoiceDensity, paperSize: InvoicePaperSize = 'A4'): InvoiceStyle {
  const tight = density === 'COMPACT' ? 0.7 : 1;
  const paper = PAPER[paperSize] ?? PAPER.A4;
  const a5 = paperSize === 'A5';
  // A5 is ~0.7 of A4's width: type steps down a little (never below a readable size) and the fixed blocks narrow.
  const f = a5 ? 0.9 : 1;
  const base = {
    CLASSIC: { fontSize: 9, smallSize: 8, titleSize: 16, companySize: 14, tableBorders: 'rows' as const, headerFill: true },
    COMPACT: { fontSize: 8, smallSize: 7, titleSize: 13, companySize: 12, tableBorders: 'rows' as const, headerFill: false },
    DETAILED: { fontSize: 8.5, smallSize: 7.5, titleSize: 15, companySize: 14, tableBorders: 'grid' as const, headerFill: true },
    // Studio: a quiet letterhead (large company name, small title), thin rules, no fills — low ink.
    STUDIO: { fontSize: 8.5, smallSize: 7.5, titleSize: 10, companySize: 15, tableBorders: 'rows' as const, headerFill: false },
  }[preset];
  const margin = MARGIN[paperSize]?.[margins] ?? MARGIN.A4[margins];
  const contentW = paper.width - 2 * margin;
  return {
    preset,
    paperSize,
    headerLayout: preset === 'STUDIO' ? 'SIDE' : 'STACKED',
    pageWidth: paper.width,
    pageHeight: paper.height,
    margin,
    ...base,
    fontSize: Math.max(7, base.fontSize * f),
    smallSize: Math.max(6.5, base.smallSize * f),
    titleSize: base.titleSize * f,
    companySize: base.companySize * f,
    cellPadX: a5 ? 3 : 4,
    cellPadY: (preset === 'COMPACT' ? 3 : 4.5) * tight * (a5 ? 0.85 : 1),
    sectionGap: (preset === 'COMPACT' ? 10 : 14) * tight * (a5 ? 0.8 : 1),
    logoMaxHeight: (preset === 'COMPACT' ? 40 : preset === 'STUDIO' ? 52 : 56) * (a5 ? 0.8 : 1),
    logoMaxWidth: a5 ? 110 : 150,
    lineHeight: 1.3,
    customerLabelWidth: a5 ? 54 : 62,
    metaLabelWidth: a5 ? 60 : 70,
    totalsWidth: Math.min(a5 ? 190 : 230, contentW * (a5 ? 0.55 : 0.45)),
    summaryColumns: [0.3, 0.35, 0.35],
    signatureLineWidth: a5 ? 110 : 140,
  };
}

/* -------------------------------------------------------- formatting --- */

/**
 * Indian digit grouping (12,34,567.89), deterministic and locale-free, so the server PDF and the
 * browser print the same string. The value is a stored `numeric(…, 2)`, so `x * 100` is within
 * a hair of an integer and rounding recovers the exact paise.
 */
export function formatAmount(value: number): string {
  const paise = Math.round(Math.abs(value) * 100);
  const rupees = String(Math.floor(paise / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${value < 0 && paise ? '-' : ''}${grouped}.${String(paise % 100).padStart(2, '0')}`;
}
export const formatRupees = (value: number) => `₹${formatAmount(value)}`;

/** 2 -> "2", 2.5 -> "2.5", 2.25 -> "2.25": a quantity or a percentage without trailing zeros. */
export function formatDecimal(value: number): string {
  const hundredths = Math.round(value * 100);
  const whole = Math.trunc(hundredths / 100);
  const frac = Math.abs(hundredths % 100);
  return frac === 0 ? String(whole) : `${hundredths < 0 && whole === 0 ? '-' : ''}${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const upTo99 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const upTo999 = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? upTo99(n % 100) : ''].filter(Boolean).join(' ');
/** A whole number in the Indian system — crore, lakh, thousand, hundred. Crores above 99 recurse ("One Hundred Crore"). */
function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  return [crore ? `${indianWords(crore)} Crore` : '', lakh ? `${upTo99(lakh)} Lakh` : '', thousand ? `${upTo99(thousand)} Thousand` : '', rest ? upTo999(rest) : ''].filter(Boolean).join(' ');
}

/**
 * A stored amount in Indian words, as a bill prints it: 12550.50 -> "Rupees Twelve Thousand Five
 * Hundred Fifty and Fifty Paise Only". Works on paise, like `formatAmount`, so it never disagrees
 * with the figure printed beside it.
 */
export function amountInWords(value: number): string {
  const paise = Math.round(Math.abs(value) * 100);
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const sign = value < 0 && paise ? 'Minus ' : '';
  if (rupees === 0 && p) return `${sign}${upTo99(p)} Paise Only`;
  return `${sign}Rupees ${indianWords(rupees)}${p ? ` and ${upTo99(p)} Paise` : ''} Only`;
}

/** "Invoice-2026-27-1.pdf" — book and bill number only (no customer data), safe on every file system. */
export function invoiceFileName(bookNumber: string, billNumber: number): string {
  const safe = `${bookNumber}-${billNumber}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return `Invoice-${safe || billNumber}.pdf`;
}

/* ---------------------------------------------------- compatibility ---- */

export const isTemplateCompatible = (supportedMode: InvoiceTemplateMode, taxMode: InvoiceTaxMode) => supportedMode === 'BOTH' || supportedMode === taxMode;

/**
 * Which stored template renders a bill when the operator has not chosen one:
 *   1. the tenant default, if it is active and fits the bill's tax mode;
 *   2. otherwise the first active compatible template — BOTH before single-mode, then by name,
 *      then by id, so the choice is stable;
 *   3. otherwise null, and the caller uses the built-in Classic.
 * A Studio-preset template (Legacy Studio) is never picked in step 2: it was added to existing
 * tenants later, and must not quietly become what their bills print — it prints only as the
 * default or when chosen.
 * An explicitly chosen template is validated by the caller instead (it must fit, or it is refused).
 */
export function pickInvoiceTemplate<T extends { id: string; templateName: string; supportedMode: InvoiceTemplateMode; isDefault: boolean; isActive: boolean; layoutPreset?: string }>(
  templates: T[],
  taxMode: InvoiceTaxMode,
): T | null {
  const usable = templates.filter((t) => t.isActive && isTemplateCompatible(t.supportedMode, taxMode));
  const def = usable.find((t) => t.isDefault);
  if (def) return def;
  const ranked = usable.filter((t) => t.layoutPreset !== 'STUDIO').sort((a, b) => Number(b.supportedMode === 'BOTH') - Number(a.supportedMode === 'BOTH') || a.templateName.localeCompare(b.templateName) || a.id.localeCompare(b.id));
  return ranked[0] ?? null;
}

/* ------------------------------------------------------------ builder -- */

const COLUMN_WEIGHT: Record<InvoiceColumn, number> = {
  serial: 0.45, item: 2, product: 2.3, hsn: 1, quantity: 0.75, rate: 1.15, amount: 1.25, discount: 1.1, taxable: 1.25, gstRate: 0.75, gstAmount: 1.1, total: 1.35, remark: 1.8,
};
/** Only these columns may wrap onto a second line; a number broken across lines is unreadable. */
const WRAPPING_COLUMNS: InvoiceColumn[] = ['item', 'product', 'remark'];
const COLUMN_ALIGN: Record<InvoiceColumn, InvoiceCellAlign> = {
  serial: 'center', item: 'left', product: 'left', hsn: 'left', quantity: 'right', rate: 'right', amount: 'right', discount: 'right', taxable: 'right', gstRate: 'right', gstAmount: 'right', total: 'right', remark: 'left',
};
/** Columns that only mean something when tax was charged. `taxable` equals `total` without GST, so it would only repeat it. */
const GST_ONLY_COLUMNS: InvoiceColumn[] = ['gstRate', 'gstAmount', 'taxable'];

type Line = InvoiceBillSource['items'][number];
const CELL: Record<InvoiceColumn, (l: Line, i: number) => string> = {
  serial: (_l, i) => String(i + 1),
  item: (l) => l.itemNameSnapshot,
  product: (l) => l.subItemNameSnapshot,
  hsn: (l) => l.hsnCodeSnapshot || '-',
  quantity: (l) => formatDecimal(l.quantity),
  rate: (l) => formatAmount(l.rate),
  amount: (l) => formatAmount(l.grossTaxable),
  // The line's STORED share of the bill discount (docs/BILLING_CALCULATION.md) — never re-allocated here.
  discount: (l) => formatAmount(l.discountAllocated),
  taxable: (l) => formatAmount(l.taxableAmount),
  gstRate: (l) => `${formatDecimal(l.gstRateSnapshot)}%`,
  gstAmount: (l) => formatAmount(l.gstAmount),
  total: (l) => formatAmount(l.lineTotal),
  remark: (l) => l.remark ?? '',
};

const present = (v: string | null | undefined): v is string => !!v && !!v.trim();

export function buildInvoiceModel(input: {
  bill: InvoiceBillSource;
  company: CompanyProfile | null;
  dateFormat: DateFormat;
  template: InvoiceTemplateSource;
  /** Print & Invoice settings; absent = the defaults (nothing extra configured). */
  print?: PrintSettings;
  /** The bill's derived payment position — printed only by a template that shows payments. */
  payments?: InvoicePayments | null;
  /** This print's copy label, overriding the settings' default (the preview's Original / Duplicate choice). */
  copyLabel?: InvoiceCopyLabel;
  isSample?: boolean;
}): InvoiceRenderModel {
  const { bill, company, dateFormat, template } = input;
  const print = input.print ?? DEFAULT_PRINT_SETTINGS;
  const cfg = template.config;
  const withGst = bill.taxMode === 'WITH_GST';
  const date = (v: string | null) => formatDateOnly(v, dateFormat);

  // Header: only the company details this company actually has AND the template shows.
  const lines: string[] = [];
  if (company && cfg.header.showCompanyAddress) {
    const place = [company.city, company.state].filter(present).join(', ');
    const cityLine = [place, company.pincode].filter(present).join(' - ');
    lines.push(...[company.addressLine1, company.addressLine2, cityLine].filter(present));
  }
  const contact = [cfg.header.showCompanyPhone && present(company?.phone) ? `Phone: ${company!.phone}` : null, cfg.header.showCompanyEmail && present(company?.email) ? `Email: ${company!.email}` : null].filter(present);
  if (contact.length) lines.push(contact.join('   '));
  if (company && cfg.header.showCompanyGstin && present(company.taxId)) lines.push(`GSTIN: ${company.taxId}`);

  const meta: InvoiceField[] = [
    { label: 'Bill No.', value: String(bill.billNumber), strong: true },
    { label: 'Book', value: bill.bookNumber },
    { label: 'Bill Date', value: date(bill.billDate) },
  ];
  if (cfg.customer.showDeliveryDate && bill.deliveryDate) meta.push({ label: 'Delivery Date', value: date(bill.deliveryDate) });

  const customer: InvoiceField[] = [{ label: 'Customer', value: bill.customerName, strong: true }];
  if (cfg.customer.showMobile && present(bill.mobileNumber)) customer.push({ label: 'Mobile', value: bill.mobileNumber });
  if (cfg.customer.showBabyName && present(bill.babyName)) customer.push({ label: 'Baby Name', value: bill.babyName });
  if (cfg.customer.showBirthDate && bill.hasBirthDate && bill.birthDate) customer.push({ label: 'Birth Date', value: date(bill.birthDate) });
  if (cfg.customer.showAppointmentReference && bill.appointmentNumber != null) customer.push({ label: 'Appointment', value: `#${bill.appointmentNumber}` });

  // Without GST, Taxable and the GST columns go (Taxable would only repeat Total), and so does
  // Amount (Qty x Rate) when there is no discount — it would print the same figure twice.
  // A Discount column on a bill without a discount would be a column of zeros.
  const keys = cfg.columns.filter((k) => !(k === 'discount' && bill.discountAmount <= 0) && (withGst || (!GST_ONLY_COLUMNS.includes(k) && !(k === 'amount' && bill.discountAmount <= 0))));
  const columns = keys.map((key) => ({ key, label: key === 'total' && !withGst ? 'Amount' : INVOICE_COLUMN_LABELS[key], align: COLUMN_ALIGN[key], weight: COLUMN_WEIGHT[key], wrap: WRAPPING_COLUMNS.includes(key) }));
  if (!withGst) {
    // With a discount the pre-discount figure differs from the line's Amount: call it Gross.
    const gross = columns.find((c) => c.key === 'amount');
    if (gross) gross.label = 'Gross';
  }
  const rows = bill.items.map((l, i) => keys.map((k) => CELL[k](l, i)));

  const totals: InvoiceRenderModel['totals'] = [];
  const t = cfg.totals;
  if (t.showSubTotal) totals.push({ label: 'Sub Total', value: formatAmount(bill.subTotal), strong: false });
  if (t.showDiscount && bill.discountAmount > 0) {
    const pct = bill.discountType === 'PERCENT' ? ` (${formatDecimal(bill.discountValue)}%)` : '';
    totals.push({ label: `Discount${pct}`, value: `-${formatAmount(bill.discountAmount)}`, strong: false });
  }
  if (withGst && t.showTaxableTotal) totals.push({ label: 'Taxable Amount', value: formatAmount(bill.netTaxable), strong: false });
  if (withGst && t.showGstTotal) totals.push({ label: 'GST', value: formatAmount(bill.gstAmount), strong: false });
  totals.push({ label: 'Grand Total', value: formatRupees(bill.grandTotal), strong: true });
  // Payments only as the server derived them (active receipts + applied advance) — an unapplied
  // customer advance or a cancelled receipt is not in `paid`. Formatted, never computed, here.
  if (t.showPayments && input.payments) {
    totals.push({ label: 'Advance / Received', value: formatAmount(input.payments.paid), strong: false });
    totals.push({ label: 'Balance Due', value: formatRupees(input.payments.outstanding), strong: false, bold: true });
  }

  const summaryRows = withGst && t.showGstSummary ? bill.gstSummary : [];
  const gstSummary = summaryRows.length
    ? {
        columns: ['GST Rate', 'Taxable', 'GST'],
        rows: summaryRows.map((r) => [`${formatDecimal(r.gstRate)}%`, formatAmount(r.taxableAmount), formatAmount(r.gstAmount)]),
        // The summary's own totals are the bill's: netTaxable and gstAmount, read, not re-added.
        total: ['Total', formatAmount(bill.netTaxable), formatAmount(bill.gstAmount)],
      }
    : null;

  // The logo prints when the template shows it AND Print settings have not switched logos off.
  const logo = company?.logo && cfg.header.showLogo && print.showLogo ? { companyId: company.id, version: company.logo.version, contentType: company.logo.contentType, alignment: cfg.header.logoAlignment } : null;
  const image = (ref: CompanyProfile['signature']) => (company && ref ? { companyId: company.id, version: ref.version, contentType: ref.contentType } : null);

  // Terms: the template's own text when it has some; otherwise the tenant's (Print & Invoice
  // settings) — so a template that shows terms without its own text prints the company's.
  const terms = !cfg.footer.showTerms ? null : present(cfg.footer.terms) ? cfg.footer.terms : print.showTerms && present(print.terms) ? print.terms : null;
  const b = print.bank;
  const bank = print.showBankDetails
    ? [
        { label: 'Bank', value: b.bankName },
        { label: 'A/c Name', value: b.accountName },
        { label: 'A/c No.', value: b.accountNumber },
        { label: 'IFSC', value: b.ifsc },
        { label: 'Branch', value: b.branch },
      ].filter((f) => present(f.value))
    : [];
  const copy = input.copyLabel ?? print.copyLabel;
  const signatory = cfg.footer.showSignatory && company ? `For ${company.name}` : null;

  return {
    isSample: !!input.isSample,
    template: { id: template.id, name: template.templateName, layoutPreset: template.layoutPreset, supportedMode: template.supportedMode },
    taxMode: bill.taxMode,
    title: withGst ? cfg.header.title : cfg.header.titleWithoutGst,
    style: invoiceStyle(template.layoutPreset, cfg.page.margins, cfg.page.density, cfg.page.paperSize),
    copyLabel: copy === 'NONE' ? null : INVOICE_COPY_LABEL_TEXT[copy],
    accent: INVOICE_ACCENT_COLORS[print.accent] ?? INVOICE_ACCENT_COLORS.NEUTRAL,
    labels: {
      billedTo: 'BILLED TO', details: 'INVOICE DETAILS', gstSummary: 'GST SUMMARY', remark: 'REMARK', terms: 'TERMS & CONDITIONS', signatoryCaption: 'Authorised Signatory',
      bank: 'BANK DETAILS', note: 'NOTE', receivedBy: 'Received By', amountInWords: 'Amount in words',
    },
    header: { alignment: cfg.header.alignment, logo, companyName: cfg.header.showCompanyName && company ? company.name : null, lines },
    meta,
    customer,
    columns,
    rows,
    totals,
    amountInWords: t.showAmountInWords ? amountInWords(bill.grandTotal) : null,
    gstSummary,
    remark: cfg.customer.showRemark && present(bill.remark) ? bill.remark : null,
    footer: {
      terms,
      thankYou: cfg.footer.showThankYou && present(cfg.footer.thankYou) ? cfg.footer.thankYou : null,
      signatory,
      note: present(print.invoiceNote) ? print.invoiceNote : null,
      text: present(print.footerText) ? print.footerText : null,
      bank: bank.length ? bank : null,
      receivedBy: !!cfg.footer.showReceivedBy,
      signatureImage: signatory && print.showSignature ? image(company?.signature ?? null) : null,
      footerImage: print.showFooterImage ? image(company?.footerImage ?? null) : null,
    },
    showPageNumbers: print.showPageNumbers,
    documentLabel: `${bill.bookNumber} / ${bill.billNumber}`,
    fileName: invoiceFileName(bill.bookNumber, bill.billNumber),
  };
}

/* -------------------------------------------------------- sample bill --- */

/**
 * The designer's preview bill: deterministic, in memory only, never saved. It exercises every
 * section — baby name, birth date, remark, mixed GST slabs including 0%, a percentage discount —
 * and its figures come from the same `calculateBill` the API stores bills with.
 */
export function sampleInvoiceBill(taxMode: InvoiceTaxMode = 'WITH_GST'): InvoiceBillSource {
  const lines = [
    { item: 'Photography', product: 'Newborn Shoot — Premium', hsn: '998383', gstRate: 18, quantity: 1, rate: 12500, remark: '2 hours, 3 set-ups' },
    { item: 'Album', product: 'Photo Album 12x36', hsn: '4911', gstRate: 12, quantity: 1, rate: 8500, remark: null },
    { item: 'Prints', product: 'Canvas Print 16x20', hsn: '4911', gstRate: 12, quantity: 2, rate: 1750, remark: null },
    { item: 'Digital', product: 'Edited Soft Copies', hsn: '998386', gstRate: 5, quantity: 40, rate: 75, remark: null },
    { item: 'Frame', product: 'Wooden Frame A4', hsn: '4414', gstRate: 0, quantity: 1, rate: 950, remark: null },
  ];
  const calc = calculateBill(lines.map((l) => ({ quantity: l.quantity, rate: l.rate, gstRate: l.gstRate })), taxMode, { type: 'PERCENT', value: 5 });
  return {
    bookNumber: '2026-27',
    billNumber: 125,
    billDate: '2026-09-25',
    deliveryDate: '2026-10-05',
    taxMode,
    customerName: 'Sample Customer',
    mobileNumber: '98765 43210',
    babyName: 'Aarav',
    hasBirthDate: true,
    birthDate: '2026-08-14',
    remark: 'Sample data — this is not a real bill.',
    appointmentNumber: 42,
    discountType: 'PERCENT',
    discountValue: 5,
    discountAmount: calc.totals.discountAmount,
    subTotal: calc.totals.subTotal,
    netTaxable: calc.totals.netTaxable,
    gstAmount: calc.totals.gstAmount,
    grandTotal: calc.totals.grandTotal,
    items: lines.map((l, i) => ({
      itemNameSnapshot: l.item,
      subItemNameSnapshot: l.product,
      hsnCodeSnapshot: l.hsn,
      gstRateSnapshot: l.gstRate,
      quantity: l.quantity,
      rate: l.rate,
      grossTaxable: calc.lines[i].grossTaxable,
      discountAllocated: calc.lines[i].discountAllocated,
      taxableAmount: calc.lines[i].taxableAmount,
      gstAmount: calc.lines[i].gstAmount,
      lineTotal: calc.lines[i].lineTotal,
      remark: l.remark,
    })),
    gstSummary: calc.gstSummary,
  };
}

/** The sample bill's payment position for previews: a round advance, the rest due. Sample only — a real bill's comes from the server. */
export function sampleInvoicePayments(bill: InvoiceBillSource): InvoicePayments {
  const grand = Math.round(bill.grandTotal * 100);
  const paid = Math.min(500_000, grand);
  return { paid: paid / 100, outstanding: (grand - paid) / 100 };
}
