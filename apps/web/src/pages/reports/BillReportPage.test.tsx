// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillDetailReport, BillReportTab, BillSummaryReport } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import type { BillReportScope } from '@/lib/billReport';
import BillReportPage from './BillReportPage';

/**
 * Renders the REAL Bill Summary Report — its imports, DataTable, the filter bar and the UI kit — so a
 * runtime-only failure fails here. Only the server calls are stubbed: every figure is what the API
 * returns, and the page shows it as-is. Pins the contract: ONE screen, Summary by default, both
 * tabs on ONE scope that a tab switch never resets, whole-result totals, no fake per-line Advance.
 */

const summary: BillSummaryReport = {
  from: '2026-08-01',
  to: '2026-08-31',
  total: 41,
  rows: [
    { id: 'a', bookNumber: 'G-2026', billNumber: 7, billDate: '2026-08-05', plannedDelivery: '2026-09-10', customerName: 'Riya Shah', mobileNumber: '9812345670', babyName: 'Baby Riya', seriesType: 'WITH_GST', subTotal: 10000, discount: 1000, gst: 972, grandTotal: 9972, advance: 3000, paymentStatus: 'PARTIALLY_PAID' },
    { id: 'c', bookNumber: 'N-2026', billNumber: 3, billDate: '2026-08-25', plannedDelivery: null, customerName: 'Karan Mehta', mobileNumber: '9898989898', babyName: null, seriesType: 'WITHOUT_GST', subTotal: 5000, discount: 0, gst: 0, grandTotal: 5000, advance: 1200, paymentStatus: 'PARTIALLY_PAID' },
  ],
  // The WHOLE filtered set (more bills than this page) — the footer must show these, not a page sum.
  totals: { bills: 41, subTotal: 123456.78, discount: 4321, gst: 999.99, grandTotal: 120135.77, advance: 55555.55 },
};
const line = (billId: string, lineNumber: number, firstLine: boolean, advance: number | null) => ({
  key: `${billId}:${lineNumber}`,
  billId,
  lineNumber,
  firstLine,
  bookNumber: 'G-2026',
  billNumber: billId === 'a' ? 7 : 3,
  billDate: '2026-08-05',
  customerName: billId === 'a' ? 'Riya Shah' : 'Karan Mehta',
  mobileNumber: '9812345670',
  babyName: null,
  itemName: 'Album',
  productName: `Product ${billId}${lineNumber}`,
  quantity: 1,
  rate: 1000,
  amount: 1000,
  discount: 0,
  taxable: 1000,
  gstRate: 18,
  gst: 180,
  lineTotal: 1180,
  advance,
});
const detailed: BillDetailReport = {
  from: '2026-08-01',
  to: '2026-08-31',
  total: 3,
  rows: [line('a', 1, true, 3000), line('a', 2, false, null), line('c', 1, true, 1200)],
  totals: { bills: 41, items: 97, subTotal: 123456.78, discount: 4321, taxable: 119135.78, gst: 999.99, grandTotal: 120135.77, advance: 55555.55 },
};

const calls: { tab: BillReportTab; scope: BillReportScope; page?: number }[] = [];
let empty = false;
vi.mock('@/lib/billReport', async (orig) => ({
  ...(await orig<typeof import('@/lib/billReport')>()),
  useBillReport: (tab: BillReportTab, scope: BillReportScope, list: { page: number }) => {
    calls.push({ tab, scope, page: list.page });
    const data = empty ? { ...summary, rows: [], total: 0, totals: { ...summary.totals, bills: 0 } } : tab === 'summary' ? summary : detailed;
    return { data, isFetching: false, isError: false, refetch: vi.fn() };
  },
  useBillReportCustomer: () => ({ data: { customerKey: '9812345670', customerName: 'Riya Shah', mobileNumber: '9812345670', billCount: 3 } }),
  useBillReportCustomers: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: { get: vi.fn(async () => []), put: vi.fn(async () => ({})), blob: vi.fn() },
}));
vi.mock('@/lib/settings', () => ({
  useDateFormatters: () => ({ date: (v: string) => v, stamp: (v: string) => v, stampTime: (v: string) => v }),
  useDisplayFormats: () => ({ dateFormat: 'dd-MM-yyyy', timeFormat: 'hh:mm tt' }),
  useCompanyProfile: () => ({ data: null }),
  useCompanyLogo: () => ({ data: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Tester', email: 't@test.local', roleId: 'r1', roleKey: null, roleName: 'Test', isSuperAdmin: false, grants, companyIds: [], branchIds: [] });

let root: Root;
let host: HTMLDivElement;
let location = '';
const uncaught: unknown[] = [];
const onError = (e: ErrorEvent) => uncaught.push(e.error ?? e.message);
function Where() {
  location = useLocation().search;
  return null;
}
async function render(path: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/modules/reports/bills" element={<><BillReportPage /><Where /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const footerRow = () => document.body.querySelector('tfoot')?.textContent ?? '';

describe('Bill Summary Report renders for real', () => {
  beforeEach(() => {
    uncaught.length = 0;
    calls.length = 0;
    empty = false;
    window.addEventListener('error', onError);
    useAuthStore.setState({ user: user({ reports_bills: ['read'], operations_billing: ['read'] }) });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener('error', onError);
    useAuthStore.setState({ user: null });
  });

  it('one screen, Summary by default: saved figures per bill and a totals row of the WHOLE filtered set', async () => {
    await render('/modules/reports/bills');
    expect(uncaught).toEqual([]);
    expect(document.body.querySelectorAll('h2')).toHaveLength(1);
    expect(text()).toContain('Bill Summary Report');
    expect(calls.at(-1)?.tab).toBe('summary');
    const heads = [...document.body.querySelectorAll('thead th')].map((t) => t.textContent?.trim());
    expect(heads).toEqual(['Book No.', 'Bill No.', 'Customer Name', 'Mobile', 'Bill Date', 'Sub Total', 'Discount', 'GST', 'Grand Total', 'Advance / Received']);
    // Baby Name / Planned Delivery / Series / Payment are one click away in Columns, not dropped.
    expect(text()).toContain('Riya Shah');
    expect(text()).toContain('₹9,972.00');
    // Totals are the server's whole-set figures, not the two rows added up.
    expect(footerRow()).toContain('41 bills');
    expect(footerRow()).toContain('₹123,456.78'.replace('123,456', '1,23,456'));
    expect(footerRow()).toContain('₹55,555.55');
    // The active date range the server used is on screen.
    const dates = [...document.body.querySelectorAll('input[aria-label^="Bill date"]')].map((i) => (i as HTMLInputElement).value);
    expect(dates).toEqual(['01-08-2026', '31-08-2026']);
    // The Advance / Received definition is spelled out once.
    const note = 'Advance / Received includes payments received or applied against the bill. Unapplied customer advance is excluded.';
    expect(text().split(note)).toHaveLength(2);
    // The totals strip carries the legacy four primary totals in their order, and not GST.
    expect(text()).toContain('Bills 41Sub Total ₹1,23,456.78Discount ₹4,321.00Advance / Received ₹55,555.55Grand Total ₹1,20,135.77');
    expect(text()).not.toContain('GST ₹999.99');
  });

  it('switching tabs keeps every filter; Detailed shows item lines and reconciles to the same totals', async () => {
    await render('/modules/reports/bills?from=2026-08-01&to=2026-08-31&customer=9812345670&book=bk1&series=WITH_GST&payment=PARTIALLY_PAID');
    const before = calls.at(-1)!.scope;
    expect(before).toMatchObject({ from: '2026-08-01', to: '2026-08-31', customer: '9812345670', bookId: 'bk1', seriesType: 'WITH_GST', paymentStatus: 'PARTIALLY_PAID' });
    await click(button('Detailed'));
    expect(uncaught).toEqual([]);
    expect(calls.at(-1)?.tab).toBe('detailed');
    expect(calls.at(-1)?.scope).toEqual(before);
    expect(calls.at(-1)?.page).toBe(1);
    expect(location).toContain('tab=detailed');
    expect(location).toContain('customer=9812345670');
    // Item lines, the bill identity once per bill, Advance only on a bill's first line.
    expect(text()).toContain('Product a2');
    expect(document.body.querySelectorAll('table a[aria-label^="Open bill"]')).toHaveLength(2);
    expect(footerRow()).toContain('41 bills · 97 items');
    expect(footerRow()).toContain('₹1,20,135.77');
    expect(footerRow()).toContain('₹55,555.55');
    await click(button('Summary'));
    expect(calls.at(-1)).toEqual({ tab: 'summary', scope: before, page: 1 });
    expect(text()).toContain('Customer Riya Shah');
  });

  it('More filters apply together and show in the scope; Clear all resets to the default month', async () => {
    await render('/modules/reports/bills?from=2026-08-01&to=2026-08-31');
    await click(button('More filters'));
    const panel = document.body.querySelector('[aria-label="More filters"]')!;
    const series = panel.querySelectorAll('select')[1] as HTMLSelectElement;
    await act(async () => {
      series.value = 'WITHOUT_GST';
      series.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls.at(-1)?.scope.seriesType).toBeUndefined(); // nothing applied yet
    await click(button('Apply'));
    expect(calls.at(-1)?.scope).toMatchObject({ from: '2026-08-01', seriesType: 'WITHOUT_GST' });
    expect(text()).toContain('Without GST');
    await click([...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Clear all'))!);
    expect(calls.at(-1)?.scope).toEqual({ from: undefined, to: undefined, customer: undefined, bookId: undefined, seriesType: undefined, billNumber: undefined, paymentStatus: undefined });
  });

  it('changing any filter starts again at page 1 (never an empty page 3 of a smaller scope)', async () => {
    await render('/modules/reports/bills?from=2026-08-01&to=2026-08-31');
    await click(button('2'));
    expect(calls.at(-1)?.page).toBe(2);
    await click(button('More filters'));
    const bill = document.body.querySelector('[aria-label="More filters"] input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(bill, '007');
      bill.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Apply'));
    expect(calls.at(-1)).toMatchObject({ page: 1, scope: { billNumber: '7' } }); // leading zeros dropped, never "0"
    expect(location).toContain('billNo=7');
  });

  it('no bills: a plain message, with the filters still there', async () => {
    empty = true;
    await render('/modules/reports/bills');
    expect(text()).toContain('No bills found for this period.');
    expect(document.body.querySelector('input[aria-label="Bill date from"]')).not.toBeNull();
    expect(document.body.querySelector('tfoot')).toBeNull();
  });

  it('without Billing read the bill number is plain text, not a link', async () => {
    useAuthStore.setState({ user: user({ reports_bills: ['read'] }) });
    await render('/modules/reports/bills');
    expect(uncaught).toEqual([]);
    expect(document.body.querySelectorAll('a[aria-label^="Open bill"]')).toHaveLength(0);
    expect(text()).toContain('Riya Shah');
  });
});
