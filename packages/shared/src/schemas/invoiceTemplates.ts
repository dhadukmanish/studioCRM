import { z } from 'zod';
import {
  INVOICE_ALIGNMENTS,
  INVOICE_COLUMNS,
  INVOICE_DENSITIES,
  INVOICE_LAYOUT_PRESETS,
  INVOICE_MARGINS,
  INVOICE_ORIENTATIONS,
  INVOICE_PAPER_SIZES,
  INVOICE_TEMPLATE_MODES,
  type InvoiceColumn,
  type InvoiceLayoutPreset,
  type InvoiceTemplateMode,
} from '../enums.js';

/**
 * Invoice template configuration — a CONTROLLED presentation schema (docs/INVOICE_TEMPLATES.md).
 *
 * Every level is `.strict()`: an unknown key is an error, not silently dropped, so a malformed or
 * hand-crafted config is refused instead of half-applied. There is no HTML, CSS, URL or
 * expression anywhere in it — text fields are plain text, rendered as text by both the browser
 * preview and the PDF.
 *
 * What identifies the invoice is NOT configurable and always prints: the invoice title, the bill
 * number, the bill date, the customer name and the Grand Total.
 */

export const INVOICE_TEMPLATE_LIMITS = { templateName: 60, description: 200, title: 40, terms: 1000, thankYou: 120 } as const;

// Plain text: no control characters other than line breaks and tabs.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const plainText = (label: string, max: number) =>
  z
    .string({ invalid_type_error: `${label} must be text` })
    .max(max, `${label} cannot exceed ${max} characters`)
    .refine((s) => !CONTROL.test(s), `${label} contains characters that cannot be printed`)
    .transform((s) => s.replace(/\r\n?/g, '\n').trim());

const bool = z.boolean();
const oneOf = <T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z.enum(values, { errorMap: () => ({ message: `${label} must be one of ${values.join(', ')}` }) });

export const invoiceTemplateConfigSchema = z
  .object({
    header: z
      .object({
        showLogo: bool,
        logoAlignment: oneOf(INVOICE_ALIGNMENTS, 'Logo alignment'),
        alignment: oneOf(INVOICE_ALIGNMENTS, 'Header alignment'),
        showCompanyName: bool,
        showCompanyAddress: bool,
        showCompanyPhone: bool,
        showCompanyEmail: bool,
        showCompanyGstin: bool,
        /** Printed on a WITH_GST bill. */
        title: plainText('Invoice title', INVOICE_TEMPLATE_LIMITS.title).pipe(z.string().min(1, 'Invoice title is required')),
        /** Printed on a WITHOUT_GST bill — kept separate so "Tax Invoice" never heads a bill that charged no tax. */
        titleWithoutGst: plainText('Invoice title (without GST)', INVOICE_TEMPLATE_LIMITS.title).pipe(z.string().min(1, 'Invoice title (without GST) is required')),
      })
      .strict(),
    customer: z
      .object({
        showMobile: bool,
        showBabyName: bool,
        showBirthDate: bool,
        showAppointmentReference: bool,
        showDeliveryDate: bool,
        showRemark: bool,
      })
      .strict(),
    /** The printed columns, in print order. Visibility is membership; order is position. */
    columns: z
      .array(oneOf(INVOICE_COLUMNS, 'Column'), { invalid_type_error: 'Columns must be a list' })
      .min(1, 'Choose at least one column')
      .max(INVOICE_COLUMNS.length)
      .refine((c) => new Set(c).size === c.length, 'A column can appear only once')
      .refine((c) => c.includes('item') || c.includes('product'), 'Show the Item or the Product column, so a line says what was sold')
      .refine((c) => c.includes('total'), 'The Total column is required'),
    totals: z
      .object({
        showSubTotal: bool,
        showDiscount: bool,
        showTaxableTotal: bool,
        showGstTotal: bool,
        showGstSummary: bool,
      })
      .strict(),
    footer: z
      .object({
        showTerms: bool,
        terms: plainText('Terms', INVOICE_TEMPLATE_LIMITS.terms),
        showThankYou: bool,
        thankYou: plainText('Thank-you note', INVOICE_TEMPLATE_LIMITS.thankYou),
        showSignatory: bool,
      })
      .strict(),
    page: z
      .object({
        paperSize: oneOf(INVOICE_PAPER_SIZES, 'Paper size'),
        orientation: oneOf(INVOICE_ORIENTATIONS, 'Orientation'),
        margins: oneOf(INVOICE_MARGINS, 'Margins'),
        density: oneOf(INVOICE_DENSITIES, 'Spacing'),
      })
      .strict(),
  })
  .strict();
export type InvoiceTemplateConfig = z.infer<typeof invoiceTemplateConfigSchema>;

/** Create / update body. `isDefault` is not here: the default moves only through its own endpoint. */
export const invoiceTemplateSchema = z.object({
  templateName: z
    .string({ required_error: 'Template name is required' })
    .trim()
    .min(1, 'Template name is required')
    .max(INVOICE_TEMPLATE_LIMITS.templateName, `Template name cannot exceed ${INVOICE_TEMPLATE_LIMITS.templateName} characters`),
  description: plainText('Description', INVOICE_TEMPLATE_LIMITS.description).nullish().transform((v) => v || null),
  supportedMode: oneOf(INVOICE_TEMPLATE_MODES, 'Supported invoice mode'),
  layoutPreset: oneOf(INVOICE_LAYOUT_PRESETS, 'Layout preset'),
  isActive: z.boolean().default(true),
  config: invoiceTemplateConfigSchema,
});
export type InvoiceTemplateInput = z.infer<typeof invoiceTemplateSchema>;

/* ------------------------------------------------------------ starters -- */

const CLASSIC_COLUMNS: InvoiceColumn[] = ['serial', 'item', 'product', 'quantity', 'rate', 'taxable', 'gstRate', 'gstAmount', 'total'];

const baseConfig = (): InvoiceTemplateConfig => ({
  header: {
    showLogo: true, logoAlignment: 'LEFT', alignment: 'LEFT',
    showCompanyName: true, showCompanyAddress: true, showCompanyPhone: true, showCompanyEmail: true, showCompanyGstin: true,
    title: 'Tax Invoice', titleWithoutGst: 'Invoice',
  },
  customer: { showMobile: true, showBabyName: true, showBirthDate: true, showAppointmentReference: false, showDeliveryDate: true, showRemark: true },
  columns: CLASSIC_COLUMNS,
  totals: { showSubTotal: true, showDiscount: true, showTaxableTotal: true, showGstTotal: true, showGstSummary: true },
  footer: { showTerms: false, terms: '', showThankYou: true, thankYou: 'Thank you for choosing us.', showSignatory: true },
  page: { paperSize: 'A4', orientation: 'PORTRAIT', margins: 'NORMAL', density: 'NORMAL' },
});

export interface StarterInvoiceTemplate {
  templateName: string;
  description: string;
  supportedMode: InvoiceTemplateMode;
  layoutPreset: InvoiceLayoutPreset;
  isDefault: boolean;
  config: InvoiceTemplateConfig;
}

/**
 * The templates every tenant starts with. Classic is BOTH-compatible and the default, so any
 * bill always has a template to print with. Seeded once per tenant (never re-created, never
 * overwritten) by `ensureStarterTemplates`.
 */
export function starterInvoiceTemplates(): StarterInvoiceTemplate[] {
  const classic = baseConfig();
  const compact = baseConfig();
  compact.header = { ...compact.header, showCompanyEmail: false };
  compact.customer = { ...compact.customer, showBirthDate: false, showRemark: false };
  compact.columns = ['serial', 'product', 'quantity', 'rate', 'gstRate', 'total'];
  compact.totals = { ...compact.totals, showGstSummary: false };
  compact.footer = { ...compact.footer, showSignatory: false };
  compact.page = { ...compact.page, margins: 'NARROW', density: 'COMPACT' };
  const detailed = baseConfig();
  detailed.header = { ...detailed.header, alignment: 'CENTER', logoAlignment: 'CENTER' };
  detailed.customer = { ...detailed.customer, showAppointmentReference: true };
  detailed.columns = ['serial', 'item', 'product', 'hsn', 'quantity', 'rate', 'amount', 'taxable', 'gstRate', 'gstAmount', 'total'];
  detailed.footer = { ...detailed.footer, showTerms: true, terms: 'Goods once delivered will not be taken back.\nSubject to local jurisdiction.' };
  return [
    { templateName: 'Classic', description: 'Balanced layout for every bill, with or without GST.', supportedMode: 'BOTH', layoutPreset: 'CLASSIC', isDefault: true, config: classic },
    { templateName: 'Compact', description: 'Short, tight layout — fewer columns and details.', supportedMode: 'BOTH', layoutPreset: 'COMPACT', isDefault: false, config: compact },
    { templateName: 'Detailed GST', description: 'Full tax invoice: HSN, amount before discount, GST summary and terms.', supportedMode: 'WITH_GST', layoutPreset: 'DETAILED', isDefault: false, config: detailed },
  ];
}

/** The template used when a tenant has none that fits — so an invoice can always be rendered. */
export const BUILT_IN_INVOICE_TEMPLATE = (): StarterInvoiceTemplate => ({ ...starterInvoiceTemplates()[0], templateName: 'Classic (built-in)', isDefault: false });
