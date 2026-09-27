import { z } from 'zod';
import { INVOICE_ACCENTS, INVOICE_COPY_LABELS, type InvoiceAccent } from '../enums.js';
import { plainText } from './invoiceTemplates.js';

/**
 * Print & Invoice settings — tenant-wide print CONTENT and preferences, stored under the `print` key
 * of the tenant's app settings (no table of their own). Templates decide layout; these supply what
 * every template may print: bank details, note, terms, footer text, the copy label, the accent, and
 * whether the logo / signature / footer image appear. See docs/INVOICE_TEMPLATES.md.
 *
 * Presentation only, like a template: nothing here can change a figure, and saving them never
 * touches a bill. An invoice always renders with the CURRENT settings — the same rule the company
 * name and logo already follow.
 */
export const PRINT_SETTINGS_LIMITS = { bankField: 60, invoiceNote: 300, terms: 1000, footerText: 200, maxDeliveryDays: 90 } as const;

const bankField = (label: string) => plainText(label, PRINT_SETTINGS_LIMITS.bankField).pipe(z.string().refine((v) => !v.includes('\n'), `${label} must be one line`));

export const printSettingsSchema = z
  .object({
    showLogo: z.boolean(),
    showSignature: z.boolean(),
    showFooterImage: z.boolean(),
    showBankDetails: z.boolean(),
    showTerms: z.boolean(),
    showPageNumbers: z.boolean(),
    bank: z
      .object({
        bankName: bankField('Bank name'),
        accountName: bankField('Account name'),
        accountNumber: bankField('Account number'),
        ifsc: bankField('IFSC').transform((v) => v.toUpperCase()),
        branch: bankField('Branch'),
      })
      .strict(),
    invoiceNote: plainText('Invoice note', PRINT_SETTINGS_LIMITS.invoiceNote),
    terms: plainText('Terms & conditions', PRINT_SETTINGS_LIMITS.terms),
    footerText: plainText('Footer text', PRINT_SETTINGS_LIMITS.footerText),
    accent: z.enum(INVOICE_ACCENTS, { errorMap: () => ({ message: `Accent must be one of ${INVOICE_ACCENTS.join(', ')}` }) }),
    copyLabel: z.enum(INVOICE_COPY_LABELS, { errorMap: () => ({ message: `Copy label must be one of ${INVOICE_COPY_LABELS.join(', ')}` }) }),
    /**
     * A NEW bill's Planned Delivery suggestion: Bill Date + this many days. null = no suggestion.
     * Only ever a suggestion the operator can change; no saved bill is touched by it.
     */
    defaultDeliveryDays: z
      .number({ invalid_type_error: 'Default delivery days must be a number' })
      .int('Default delivery days must be a whole number')
      .min(0, 'Default delivery days cannot be negative')
      .max(PRINT_SETTINGS_LIMITS.maxDeliveryDays, `Default delivery days cannot exceed ${PRINT_SETTINGS_LIMITS.maxDeliveryDays}`)
      .nullable(),
  })
  .strict();
export type PrintSettings = z.infer<typeof printSettingsSchema>;

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  showLogo: true,
  showSignature: true,
  showFooterImage: true,
  showBankDetails: true,
  showTerms: true,
  showPageNumbers: true,
  bank: { bankName: '', accountName: '', accountNumber: '', ifsc: '', branch: '' },
  invoiceNote: '',
  terms: '',
  footerText: '',
  accent: 'NEUTRAL',
  copyLabel: 'ORIGINAL',
  defaultDeliveryDays: null,
};

/**
 * Whatever is stored, as settings the renderer can use — decided FIELD BY FIELD: a missing or
 * no-longer-valid value takes its default, every valid one is kept. So a later release that
 * tightens one limit can never wipe a tenant's bank details, terms or accent along with it, and
 * an unknown stored key is ignored rather than breaking every invoice of the tenant.
 */
export function toPrintSettings(raw: unknown): PrintSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const shape = printSettingsSchema.shape;
  const pick = <K extends keyof PrintSettings>(key: K): PrintSettings[K] => {
    const r = (shape[key] as z.ZodTypeAny).safeParse(src[key]);
    return r.success ? r.data : DEFAULT_PRINT_SETTINGS[key];
  };
  const bankSrc = src.bank && typeof src.bank === 'object' ? (src.bank as Record<string, unknown>) : {};
  const bankShape = shape.bank.shape;
  const bank = Object.fromEntries(
    (Object.keys(DEFAULT_PRINT_SETTINGS.bank) as (keyof PrintSettings['bank'])[]).map((k) => {
      const r = bankShape[k].safeParse(bankSrc[k]);
      return [k, r.success ? r.data : DEFAULT_PRINT_SETTINGS.bank[k]];
    }),
  ) as PrintSettings['bank'];
  const out = Object.fromEntries((Object.keys(DEFAULT_PRINT_SETTINGS) as (keyof PrintSettings)[]).map((k) => [k, k === 'bank' ? bank : pick(k)])) as PrintSettings;
  return out;
}

/**
 * The accent colours, dark and muted on purpose: they tint rules and headings only, and each prints
 * as a near-black grey on a monochrome printer.
 */
export const INVOICE_ACCENT_COLORS: Record<InvoiceAccent, string> = {
  NEUTRAL: '#111827',
  BLUE: '#1E4E8C',
  TEAL: '#0F5E59',
  GREEN: '#2F5D34',
  MAROON: '#7A2331',
  PURPLE: '#4B3B7A',
};

/** Signature / footer image limits — the same as the logo's, checked by the server from the file's own bytes. */
export const PRINT_ASSET_LABELS = { SIGNATURE: 'Signature', FOOTER: 'Footer image' } as const;
