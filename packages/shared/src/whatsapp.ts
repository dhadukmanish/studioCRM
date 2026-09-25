import { z } from 'zod';
import { formatDateOnly, type DateFormat } from './dates.js';
import type { InvoiceTaxMode } from './enums.js';
import { formatRupees, invoiceFileName, type InvoiceBillSource } from './invoice.js';
import type { CompanyProfile } from './schemas/org.js';

/**
 * Sharing a saved bill's invoice on WhatsApp (docs/WHATSAPP_SHARING.md).
 *
 * Four separate concerns, so a future official provider replaces only the last one:
 *
 *   invoice generation     — the Phase 4 PDF, unchanged, which the customer opens through a
 *                            secure public link (`/i/<token>`, Phase 5.1) — no login, no attachment
 *   message composition    — `composeInvoiceMessage` over a small, fixed variable set; the message
 *                            always carries `{InvoiceLink}` (see `fillInvoiceLink`)
 *   destination            — `whatsappDestination`: the typed number -> international digits
 *   transport              — today WHATSAPP_CLICK_TO_CHAT: `whatsappChatUrl` opens a chat with the
 *                            number and text prefilled. The operator presses Send; nothing here
 *                            can know a message was sent, delivered or read.
 */

export const SHARE_TRANSPORTS = ['WHATSAPP_CLICK_TO_CHAT'] as const;
export type ShareTransport = (typeof SHARE_TRANSPORTS)[number];

/* ------------------------------------------------------------ destination -- */

export type WhatsappDestination = { ok: true; digits: string; display: string } | { ok: false; error: string };

const INDIAN_MOBILE = /^[6-9]\d{9}$/;
const fail = (error: string): WhatsappDestination => ({ ok: false, error });
const indian = (national: string): WhatsappDestination =>
  INDIAN_MOBILE.test(national)
    ? { ok: true, digits: `91${national}`, display: `+91 ${national.slice(0, 5)} ${national.slice(5)}` }
    : fail('An Indian mobile number has 10 digits and starts with 6, 7, 8 or 9');

/**
 * The number a WhatsApp chat is opened with: international digits, no "+" (what click-to-chat
 * expects). India is the home country, so a bare 10-digit mobile gets 91; an explicit country
 * code ("+", or "00") is kept as typed and never gets a second 91.
 *
 *   98765 43210, 098765-43210, 919876543210, +91 98765 43210, 0091 9876543210  -> 919876543210
 *   +44 7700 900123                                                            -> 447700900123
 *
 * Only shape is checked — whether the number has a WhatsApp account cannot be known here.
 * Spaces, hyphens, dots and brackets are separators. It never touches the bill's stored number.
 */
export function whatsappDestination(raw: string | null | undefined): WhatsappDestination {
  const s = String(raw ?? '').trim();
  if (!s) return fail('Enter the WhatsApp number');
  if (/[^\d\s+\-().]/.test(s)) return fail('A mobile number can only contain digits');
  if (s.lastIndexOf('+') > 0) return fail('Put the + only at the start, before the country code');
  let digits = s.replace(/\D/g, '');
  const international = s.startsWith('+') || digits.startsWith('00');
  if (international) {
    if (!s.startsWith('+')) digits = digits.slice(2);
    if (digits.startsWith('91')) return indian(digits.slice(2).replace(/^0(?=\d{10}$)/, ''));
    if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return fail('Enter the country code and number, e.g. +44 7700 900123');
    return { ok: true, digits, display: `+${digits}` };
  }
  if (digits.length === 11 && digits.startsWith('0')) return indian(digits.slice(1));
  if (digits.length === 10) return indian(digits);
  if (digits.length === 12 && digits.startsWith('91')) return indian(digits.slice(2));
  return fail('Enter a 10-digit mobile number, or add the country code with +');
}

/* ---------------------------------------------------------------- message -- */

/** The only placeholders a message may use. Text, not expressions: nothing is evaluated. */
export const WHATSAPP_MESSAGE_VARIABLES = ['CustomerName', 'BookNumber', 'BillNumber', 'BillDate', 'GrandTotal', 'CompanyName', 'InvoiceLink'] as const;
export type WhatsappMessageVariable = (typeof WHATSAPP_MESSAGE_VARIABLES)[number];
export const WHATSAPP_MESSAGE_MAX = 1000;

/** The application default; a tenant may replace it in Settings → General (`whatsappInvoiceMessage`). */
export const DEFAULT_WHATSAPP_INVOICE_MESSAGE =
  'Hello {CustomerName},\n\nYour invoice {BookNumber}/{BillNumber} for {GrandTotal} is ready.\n\nView Invoice:\n{InvoiceLink}\n\nThank you,\n{CompanyName}';

export const INVOICE_LINK_PLACEHOLDER = '{InvoiceLink}';
/** Appended when a message does not place the link itself — a tenant message saved before Phase 5.1, or one edited in the dialog. */
const invoiceLinkBlock = (link: string) => `View Invoice:\n${link}`;

/**
 * A message template that is sure to carry the invoice link. One that already places
 * `{InvoiceLink}` is returned as it is; one that does not (every custom message saved before
 * Phase 5.1) gets a blank line and `View Invoice:\n{InvoiceLink}` appended. The tenant's saved
 * setting is never rewritten — this runs on every compose.
 */
export function withInvoiceLinkPlaceholder(template: string): string {
  const t = template.trimEnd();
  return t.includes(INVOICE_LINK_PLACEHOLDER) ? t : `${t}\n\n${invoiceLinkBlock(INVOICE_LINK_PLACEHOLDER)}`;
}

/**
 * Puts the real public invoice URL wherever `{InvoiceLink}` stands. If the operator removed the
 * placeholder while editing, the same `View Invoice:` block is appended — the message never
 * leaves without the link.
 */
export function fillInvoiceLink(message: string, url: string): string {
  const m = message.replace(/\r\n?/g, '\n').trim();
  return m.includes(INVOICE_LINK_PLACEHOLDER) ? m.split(INVOICE_LINK_PLACEHOLDER).join(url) : `${m}\n\n${invoiceLinkBlock(url)}`;
}

/** Placeholders in a message template that are not in the allowed set, e.g. "{Customer}". */
export function unknownMessageVariables(template: string): string[] {
  const found = [...template.matchAll(/\{([^{}\n]*)\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((v) => !(WHATSAPP_MESSAGE_VARIABLES as readonly string[]).includes(v)))];
}

/** Fills the placeholders. Unknown ones are left visible as typed — never guessed, never evaluated. */
export function composeInvoiceMessage(template: string, values: Record<WhatsappMessageVariable, string>): string {
  return template
    .replace(/\r\n?/g, '\n')
    .replace(/\{([^{}\n]*)\}/g, (all, name: string) => ((WHATSAPP_MESSAGE_VARIABLES as readonly string[]).includes(name) ? values[name as WhatsappMessageVariable] : all))
    .trim();
}

/**
 * The values a message may use, all read from what is SAVED: the bill's own customer name and
 * stored Grand Total (formatted exactly as the invoice prints it — nothing is calculated here),
 * the book/bill identity, the bill date in the tenant's date format, and the company name from
 * Company Settings.
 */
export function invoiceMessageValues(bill: Pick<InvoiceBillSource, 'customerName' | 'bookNumber' | 'billNumber' | 'billDate' | 'grandTotal'>, company: Pick<CompanyProfile, 'name'> | null, dateFormat: DateFormat): Record<WhatsappMessageVariable, string> {
  return {
    CustomerName: bill.customerName,
    BookNumber: bill.bookNumber,
    BillNumber: String(bill.billNumber),
    BillDate: formatDateOnly(bill.billDate, dateFormat),
    GrandTotal: formatRupees(bill.grandTotal),
    CompanyName: company?.name?.trim() ?? '',
    // Stays a placeholder here: the URL exists only once a link is prepared (`fillInvoiceLink`),
    // and opening the Share dialog never creates one.
    InvoiceLink: INVOICE_LINK_PLACEHOLDER,
  };
}

/* ------------------------------------------------------------- share context -- */

/** What the Share dialog opens with. The destination is only a suggestion: the operator may change it for this share. */
export interface InvoiceShareContext {
  transport: ShareTransport;
  customerName: string;
  /** The bill's saved mobile, as entered — the default destination. */
  mobileNumber: string;
  taxMode: InvoiceTaxMode;
  documentLabel: string;
  grandTotal: string;
  fileName: string;
  /** The composed message. It still holds the literal `{InvoiceLink}` — `fillInvoiceLink` puts the URL in once a link is prepared. */
  message: string;
}

export function buildInvoiceShareContext(input: {
  bill: Pick<InvoiceBillSource, 'customerName' | 'mobileNumber' | 'bookNumber' | 'billNumber' | 'billDate' | 'grandTotal' | 'taxMode'>;
  company: Pick<CompanyProfile, 'name'> | null;
  dateFormat: DateFormat;
  messageTemplate?: string | null;
}): InvoiceShareContext {
  const { bill } = input;
  const values = invoiceMessageValues(bill, input.company, input.dateFormat);
  return {
    transport: 'WHATSAPP_CLICK_TO_CHAT',
    customerName: bill.customerName,
    mobileNumber: bill.mobileNumber,
    taxMode: bill.taxMode,
    documentLabel: `${bill.bookNumber} / ${bill.billNumber}`,
    grandTotal: values.GrandTotal,
    fileName: invoiceFileName(bill.bookNumber, bill.billNumber),
    message: composeInvoiceMessage(withInvoiceLinkPlaceholder(input.messageTemplate?.trim() || DEFAULT_WHATSAPP_INVOICE_MESSAGE), values),
  };
}

/* -------------------------------------------------------------- transport -- */

/**
 * WhatsApp's public click-to-chat link. On a phone it opens the WhatsApp app; on a computer,
 * WhatsApp Desktop or Web. It prefills the chat and the text — it cannot carry a file.
 * The text is percent-encoded as UTF-8, so Gujarati, Hindi, ₹, "&", "+" and line breaks survive.
 */
export function whatsappChatUrl(destinationDigits: string, message: string): string {
  if (!/^\d{8,15}$/.test(destinationDigits)) throw new Error('Invalid WhatsApp destination');
  const text = message.replace(/\r\n?/g, '\n');
  return `https://wa.me/${destinationDigits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** Body of "the operator opened WhatsApp for this invoice" — no number, no message text. */
export const shareOpenedSchema = z
  .object({
    transport: z.enum(SHARE_TRANSPORTS).default('WHATSAPP_CLICK_TO_CHAT'),
    templateId: z.string().trim().nullish(),
  })
  .strict();
export type ShareOpenedInput = z.infer<typeof shareOpenedSchema>;

/* ------------------------------------------------------ public invoice link -- */

/**
 * A bill's public invoice link as the operator sees it (docs/WHATSAPP_SHARING.md, Phase 5.1).
 * At most one is active per bill. `url` is null exactly when there is no active link.
 */
export interface PublicInvoiceLinkState {
  active: boolean;
  url: string | null;
  /** The template the link renders with; null = the built-in Classic. */
  templateId: string | null;
  templateName: string | null;
  createdAt: string | null;
}

/** POST …/public-link — whether the bill's existing link was reused or a new one was made. */
export interface PreparedPublicInvoiceLink extends PublicInvoiceLinkState {
  active: true;
  url: string;
  outcome: 'CREATED' | 'REUSED';
}

/** Body of "prepare the public link for this template" — nothing else may be sent. */
export const publicLinkCreateSchema = z.object({ templateId: z.string().trim().nullish() }).strict();
export type PublicLinkCreateInput = z.infer<typeof publicLinkCreateSchema>;
