// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_PRINT_SETTINGS, buildInvoiceModel, legacyStudioTemplate, professionalStudioTemplate, starterInvoiceTemplates, sampleInvoiceBill, sampleInvoicePayments, type CompanyProfile } from '@erp/shared';
import { InvoiceDocument } from './InvoiceDocument';

/**
 * The browser renderer draws the Professional Studio model for real: the same sections as the PDF
 * (one customer + bill section, accent table header, words + bank beside the totals, Received By and
 * the signatory) — and never a "Bill To" or "Ship To".
 */

const company: CompanyProfile = {
  id: 'c1', name: 'Sunrise Photo Studio', legalName: null, taxId: '24ABCDE1234F1Z5', email: 'hello@sunrise.example', phone: '98250 12345', website: null,
  addressLine1: '12, Station Road', addressLine2: null, city: 'Rajkot', state: 'Gujarat', pincode: '360001', countryCode: 'IN', currency: 'INR',
  logo: { version: '1', contentType: 'image/png' }, signature: { version: '2', contentType: 'image/png' }, footerImage: null,
};
const bank = { bankName: 'State Bank of India', accountName: '', accountNumber: '12345678901', ifsc: 'SBIN0001234', branch: '' };
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});
function render(taxMode: 'WITH_GST' | 'WITHOUT_GST', images = { logo: PIXEL, signature: PIXEL }, template = professionalStudioTemplate(), co: CompanyProfile = company) {
  const bill = sampleInvoiceBill(taxMode);
  const model = buildInvoiceModel({ bill, company: co, dateFormat: 'dd/MM/yyyy', template: { id: 'p', ...template }, print: { ...DEFAULT_PRINT_SETTINGS, bank, terms: 'No refunds.', accent: 'BLUE' }, payments: sampleInvoicePayments(bill) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InvoiceDocument model={model} images={images} />));
  return host;
}

describe('InvoiceDocument — Professional Studio', () => {
  it('WITH GST: the full hierarchy, accent table header, images — and no Bill To / Ship To', () => {
    const el = render('WITH_GST');
    const text = el.textContent ?? '';
    for (const s of ['Tax Invoice', 'Original', 'Sunrise Photo Studio', 'GSTIN: 24ABCDE1234F1Z5', 'Mobile: 98250 12345', 'Email: hello@sunrise.example', 'CUSTOMER', 'BILL DETAILS', 'Planned Delivery', 'GST%', 'Total in words', 'BANK DETAILS', 'SBIN0001234', 'Grand Total', 'Advance / Received', 'Balance Due', 'TERMS & CONDITIONS', 'No refunds.', 'Received By', 'Authorised Signatory']) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toMatch(/bill(ed)?\s+to|ship\s+to/i);
    // Empty bank lines (account name, branch) are not printed as bare labels.
    expect(text).not.toContain('A/c Name');
    expect(text).not.toContain('Branch');
    const head = el.querySelector('thead tr') as HTMLElement;
    expect(head.style.background).toMatch(/rgb\(30, 78, 140\)|#1e4e8c/i);
    expect(el.querySelectorAll('img')).toHaveLength(2);
  });

  it('WITHOUT GST and no images: no GST column, no broken image box', () => {
    const el = render('WITHOUT_GST', { logo: PIXEL, signature: PIXEL }, professionalStudioTemplate(), { ...company, logo: null, signature: null });
    const text = el.textContent ?? '';
    expect(text).not.toContain('GST%');
    expect(text).not.toContain('Tax Invoice');
    // No GST total row either — only Sub Total, Discount, Grand Total, payments.
    expect([...el.querySelectorAll('span')].map((x) => x.textContent)).not.toContain('GST');
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(text).toContain('Authorised Signatory');
  });
});

describe('InvoiceDocument — existing templates keep their layout', () => {
  it('Classic: Billed To / Invoice Details, the stacked title, bank in the sign-off band, no Professional parts', () => {
    const el = render('WITH_GST', { logo: PIXEL, signature: PIXEL }, starterInvoiceTemplates()[0]);
    const text = el.textContent ?? '';
    for (const s of ['BILLED TO', 'INVOICE DETAILS', 'Phone: 98250 12345   Email: hello@sunrise.example', 'GST %', 'GST SUMMARY', 'Grand Total']) expect(text, s).toContain(s);
    for (const s of ['CUSTOMER', 'BILL DETAILS', 'Total in words', 'Mobile: 98250']) expect(text, s).not.toContain(s);
    expect((el.querySelector('thead tr') as HTMLElement).style.background).not.toMatch(/30, 78, 140/);
  });

  it('Legacy Studio: side letterhead, amount in words, bank + Received By in the sign-off band', () => {
    const el = render('WITH_GST', { logo: PIXEL, signature: PIXEL }, legacyStudioTemplate());
    const text = el.textContent ?? '';
    for (const s of ['BILLED TO', 'INVOICE DETAILS', 'Amount in words', 'BANK DETAILS', 'Received By', 'Balance Due']) expect(text, s).toContain(s);
    expect(text).not.toContain('BILL DETAILS');
    // Bank details sit after the terms (sign-off band), not beside the totals.
    expect(text.indexOf('BANK DETAILS')).toBeGreaterThan(text.indexOf('TERMS & CONDITIONS'));
  });
});
