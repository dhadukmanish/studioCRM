import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WHATSAPP_INVOICE_MESSAGE,
  appSettingsSchema,
  buildInvoiceModel,
  buildInvoiceShareContext,
  composeInvoiceMessage,
  shareOpenedSchema,
  starterInvoiceTemplates,
  unknownMessageVariables,
  whatsappChatUrl,
  whatsappDestination,
  type CompanyProfile,
  type InvoiceBillSource,
} from '@erp/shared';

/**
 * WhatsApp invoice sharing (docs/WHATSAPP_SHARING.md) — the pure parts, always run: destination
 * normalisation, message composition from the SAVED bill, click-to-chat URL encoding, and the
 * settings / audit input rules. The API side (tenant isolation, RBAC, audit, no side effects) is
 * in invoices.test.ts section B.
 */

describe('whatsappDestination — the number a chat is opened with', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['+91 9876543210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
    ['0091 98765 43210', '919876543210'],
    ['98765 43210', '919876543210'],
    ['98765-43210', '919876543210'],
    ['(98765) 43-210', '919876543210'],
    ['09876543210', '919876543210'],
    ['+91 09876543210', '919876543210'],
    ['  9876543210  ', '919876543210'],
  ])('%s -> %s (Indian mobile, one 91 only)', (raw, digits) => {
    const d = whatsappDestination(raw);
    expect(d).toMatchObject({ ok: true, digits });
    expect(d.ok && d.digits.startsWith('9191')).toBe(false);
  });

  it('shows an Indian number readably', () => {
    expect(whatsappDestination('9876543210')).toMatchObject({ display: '+91 98765 43210' });
  });

  it.each([
    ['+44 7700 900123', '447700900123'],
    ['+1 (415) 555-2671', '14155552671'],
    ['0044 7700 900123', '447700900123'],
    ['+971 50 123 4567', '971501234567'],
  ])('keeps an explicit international number: %s -> %s', (raw, digits) => {
    expect(whatsappDestination(raw)).toMatchObject({ ok: true, digits, display: `+${digits}` });
  });

  it.each([
    ['', 'Enter the WhatsApp number'],
    ['   ', 'Enter the WhatsApp number'],
    ['98765', '10-digit'],
    ['12345678901234', '10-digit'],
    ['98765abcde', 'only contain digits'],
    ['call me', 'only contain digits'],
    ['98765+43210', 'at the start'],
    ['1234567890', 'starts with 6, 7, 8 or 9'],
    ['+91 12345', 'starts with 6, 7, 8 or 9'],
    ['+44 12', 'country code'],
    ['+0 7700 900123', 'country code'],
  ])('refuses %p with a clear message', (raw, msg) => {
    const d = whatsappDestination(raw);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error).toContain(msg);
  });
});

/* ------------------------------------------------------------------ message -- */

const company = { name: 'શ્રી ગણેશ ફોટો સ્ટુડિયો' } as CompanyProfile;
const bill: InvoiceBillSource = {
  bookNumber: '2026-27', billNumber: 7, billDate: '2026-09-25', deliveryDate: null, taxMode: 'WITH_GST',
  customerName: 'પ્રિયા હર્ષદભાઈ', mobileNumber: '98765 43210', babyName: 'Aarav', hasBirthDate: false, birthDate: null, remark: null, appointmentNumber: null,
  discountType: 'PERCENT', discountValue: 10, discountAmount: 1250, subTotal: 12500, netTaxable: 11250, gstAmount: 1462.5, grandTotal: 12712.5,
  items: [{ itemNameSnapshot: 'Photography', subItemNameSnapshot: 'Newborn', hsnCodeSnapshot: '998383', gstRateSnapshot: 13, quantity: 1, rate: 12500, grossTaxable: 12500, discountAllocated: 1250, taxableAmount: 11250, gstAmount: 1462.5, lineTotal: 12712.5, remark: null }],
  gstSummary: [{ gstRate: 13, taxableAmount: 11250, gstAmount: 1462.5 }],
};

describe('the share message', () => {
  it('fills every placeholder from the saved bill, the company and the tenant date format', () => {
    const msg = composeInvoiceMessage('{CustomerName}|{BookNumber}|{BillNumber}|{BillDate}|{GrandTotal}|{CompanyName}', {
      CustomerName: 'A', BookNumber: 'B', BillNumber: '7', BillDate: '25/09/2026', GrandTotal: '₹1.00', CompanyName: 'C',
    });
    expect(msg).toBe('A|B|7|25/09/2026|₹1.00|C');
  });

  it('the default message: customer, book/bill, the stored Grand Total as the invoice prints it, the company — and no baby name', () => {
    const ctx = buildInvoiceShareContext({ bill, company, dateFormat: 'dd/MM/yyyy' });
    expect(ctx.message).toBe('Hello પ્રિયા હર્ષદભાઈ,\n\nPlease find your invoice 2026-27/7 for ₹12,712.50.\n\nThank you,\nશ્રી ગણેશ ફોટો સ્ટુડિયો');
    expect(ctx.message).not.toContain('Aarav');
    expect(ctx).toMatchObject({ transport: 'WHATSAPP_CLICK_TO_CHAT', mobileNumber: '98765 43210', fileName: 'Invoice-2026-27-7.pdf', documentLabel: '2026-27 / 7' });
  });

  it('never calculates: the total is the bill’s stored Grand Total, identical to the invoice’s, WITH and WITHOUT GST', () => {
    const template = { id: 't', ...starterInvoiceTemplates()[0] };
    const noGst: InvoiceBillSource = { ...bill, taxMode: 'WITHOUT_GST', gstAmount: 0, grandTotal: 11250, items: bill.items.map((l) => ({ ...l, gstAmount: 0, lineTotal: 11250 })) };
    for (const b of [bill, noGst, { ...bill, grandTotal: 99999.99 /* deliberately not qty x rate */ }]) {
      const invoiceTotal = buildInvoiceModel({ bill: b, company, dateFormat: 'dd/MM/yyyy', template }).totals.at(-1)!.value;
      expect(buildInvoiceShareContext({ bill: b, company, dateFormat: 'dd/MM/yyyy' }).grandTotal).toBe(invoiceTotal);
    }
  });

  it('uses the tenant’s message, with the date in the tenant’s format (not the browser locale)', () => {
    const ctx = buildInvoiceShareContext({ bill, company, dateFormat: 'yyyy-MM-dd', messageTemplate: 'નમસ્તે {CustomerName} — बिल {BillNumber} ({BillDate}) {GrandTotal}' });
    expect(ctx.message).toBe('નમસ્તે પ્રિયા હર્ષદભાઈ — बिल 7 (2026-09-25) ₹12,712.50');
  });

  it('falls back to the application default for a blank tenant message, and handles no company', () => {
    const ctx = buildInvoiceShareContext({ bill, company: null, dateFormat: 'dd/MM/yyyy', messageTemplate: '   ' });
    expect(ctx.message.startsWith('Hello પ્રિયા હર્ષદભાઈ,')).toBe(true);
    expect(ctx.message.endsWith('Thank you,')).toBe(true);
  });

  it('leaves an unknown placeholder visible instead of guessing or evaluating it', () => {
    expect(composeInvoiceMessage('Hi {Customer} {constructor} {1+1}', { CustomerName: 'A', BookNumber: '', BillNumber: '', BillDate: '', GrandTotal: '', CompanyName: '' })).toBe('Hi {Customer} {constructor} {1+1}');
    expect(unknownMessageVariables('Hi {Customer}, {CustomerName} {GrandTotal} {x}')).toEqual(['Customer', 'x']);
    expect(unknownMessageVariables(DEFAULT_WHATSAPP_INVOICE_MESSAGE)).toEqual([]);
  });
});

describe('whatsappChatUrl — click-to-chat, safely encoded', () => {
  const text = 'નમસ્તે પ્રિયા — बिल ₹65,625.00\nA & B + C = 100% #1 ?x=1';
  it('encodes the message so it decodes back exactly (Gujarati, Hindi, ₹, &, +, line breaks)', () => {
    const url = whatsappChatUrl('919876543210', text);
    expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    const q = url.split('?text=')[1];
    expect(q).not.toMatch(/[ &+#\n?=]/); // every separator is escaped
    expect(decodeURIComponent(q)).toBe(text);
    expect(new URL(url).searchParams.get('text')).toBe(text);
  });

  it('normalises Windows line breaks, and omits an empty text', () => {
    expect(new URL(whatsappChatUrl('919876543210', 'a\r\nb')).searchParams.get('text')).toBe('a\nb');
    expect(whatsappChatUrl('919876543210', '')).toBe('https://wa.me/919876543210');
  });

  it('refuses anything that is not a normalised destination', () => {
    for (const bad of ['+919876543210', '98765 43210', '12', 'abc', '91987654321012345']) expect(() => whatsappChatUrl(bad, 'x')).toThrow();
  });
});

describe('settings and audit input', () => {
  it('the tenant message: known placeholders only, not empty, at most 1000 characters', () => {
    expect(appSettingsSchema.safeParse({ whatsappInvoiceMessage: DEFAULT_WHATSAPP_INVOICE_MESSAGE }).success).toBe(true);
    expect(appSettingsSchema.safeParse({ whatsappInvoiceMessage: 'નમસ્તે {CustomerName}, बिल {BillNumber}' }).success).toBe(true);
    const unknown = appSettingsSchema.safeParse({ whatsappInvoiceMessage: 'Hi {Customer}' });
    expect(unknown.success).toBe(false);
    expect(JSON.stringify(unknown.error?.issues)).toContain('{Customer}');
    expect(appSettingsSchema.safeParse({ whatsappInvoiceMessage: '   ' }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ whatsappInvoiceMessage: 'x'.repeat(1001) }).success).toBe(false);
    expect(appSettingsSchema.safeParse({}).success).toBe(true); // optional: other settings saves are unaffected
  });

  it('the audit body carries no phone number and no message text', () => {
    expect(shareOpenedSchema.parse({})).toEqual({ transport: 'WHATSAPP_CLICK_TO_CHAT' });
    expect(shareOpenedSchema.safeParse({ templateId: 'x', mobileNumber: '9876543210' }).success).toBe(false);
    expect(shareOpenedSchema.safeParse({ message: 'hi' }).success).toBe(false);
    expect(shareOpenedSchema.safeParse({ transport: 'WHATSAPP_BUSINESS_API' }).success).toBe(false);
  });
});
