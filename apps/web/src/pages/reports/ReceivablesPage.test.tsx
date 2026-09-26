// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReceivableCustomerDetail, ReceivableCustomerRow, ReceivablesOverview, ReceivablesPage as Page } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import ReceivablesPage from './ReceivablesPage';
import ReceivableCustomerPage from './ReceivableCustomerPage';

/**
 * Renders the REAL receivables pages — their imports, the auth store, DataTable and the UI kit — so
 * a runtime-only failure fails here. Only the server calls are stubbed; every figure below is
 * what the API would return, and the pages must show it as-is (they never re-add money).
 */

const aging = { CURRENT: 999.99, D1_30: 21000, D31_60: 3000, D61_90: 0, D90_PLUS: 3456.72 };
const overview: ReceivablesOverview = { asOf: '2026-09-26', totalBilled: 47456.71, totalReceived: 19000, totalOutstanding: 28456.71, customersWithOutstanding: 6, pendingBills: 7, aging };
const customer: ReceivableCustomerRow = {
  customerKey: '9000000001',
  customerName: 'Known Customer',
  mobileNumber: '9000000001',
  billCount: 3,
  pendingBills: 2,
  totalBilled: 23000,
  totalPaid: 12000,
  totalOutstanding: 11000,
  oldestPendingDate: '2026-09-02',
  oldestPendingAge: 24,
  aging: { CURRENT: 0, D1_30: 11000, D31_60: 0, D61_90: 0, D90_PLUS: 0 },
};
// The table's search narrowed this to one customer; the scope's KPI / bucket strip must not follow it.
const customers: Page<ReceivableCustomerRow> = {
  asOf: '2026-09-26',
  rows: [customer],
  total: 1,
  page: 1,
  pageSize: 20,
  totals: { count: 1, billCount: 3, pendingBills: 2, totalBilled: 23000, totalPaid: 12000, totalOutstanding: 11000, aging: customer.aging },
};
const bill = (id: string, billNumber: number, grandTotal: number, paidAmount: number) => ({
  id,
  bookId: 'b1',
  bookNumber: '2026-27',
  billNumber,
  billDate: '2026-09-02',
  customerKey: '9000000001',
  customerName: 'Known Customer',
  mobileNumber: '9000000001',
  grandTotal,
  paidAmount,
  outstandingAmount: grandTotal - paidAmount,
  paymentStatus: paidAmount === grandTotal ? ('PAID' as const) : paidAmount ? ('PARTIALLY_PAID' as const) : ('UNPAID' as const),
  ageDays: 24,
  agingBucket: 'D1_30' as const,
});
const detail: ReceivableCustomerDetail = {
  asOf: '2026-09-26',
  customer,
  bills: [bill('x1', 1, 10000, 10000), bill('x2', 2, 5000, 2000), bill('x3', 3, 8000, 0)],
  receipts: [
    {
      receiptId: 'r1',
      receiptNumber: 19,
      receiptDate: '2026-09-10',
      paymentMode: 'CASH',
      accountName: 'CASH IN HAND',
      receiptAmount: 12000,
      allocatedAmount: 12000,
      allocations: [
        { billId: 'x1', bookNumber: '2026-27', billNumber: 1, amount: 10000 },
        { billId: 'x2', bookNumber: '2026-27', billNumber: 2, amount: 2000 },
      ],
      status: 'ACTIVE',
    },
  ],
};

vi.mock('@/lib/receivables', async (orig) => ({
  ...(await orig<typeof import('@/lib/receivables')>()),
  useReceivablesOverview: () => ({ data: overview, isFetching: false, isError: false, refetch: vi.fn() }),
  useCustomerSummaryReport: () => ({ data: customers, isFetching: false, isError: false, refetch: vi.fn() }),
  useBillReceivablesReport: () => ({ data: undefined, isFetching: false, isError: false, refetch: vi.fn() }),
  useCustomerReceivableDetail: () => ({ data: detail, isLoading: false, isError: false, refetch: vi.fn() }),
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

const user = (grants: AuthUser['grants']): AuthUser => ({
  id: 'u1',
  tenantId: 't1',
  name: 'Tester',
  email: 'tester@test.local',
  roleId: 'r1',
  roleKey: null,
  roleName: 'Test role',
  isSuperAdmin: false,
  grants,
  companyIds: [],
  branchIds: [],
});

let root: Root;
let host: HTMLDivElement;
const uncaught: unknown[] = [];
const onError = (e: ErrorEvent) => uncaught.push(e.error ?? e.message);

async function render(path: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/modules/reports/receivables" element={<ReceivablesPage />} />
            <Route path="/modules/reports/receivables/customers/:key" element={<ReceivableCustomerPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
const text = () => document.body.textContent ?? '';
const buttons = () => [...document.body.querySelectorAll('button')].map((b) => b.textContent?.trim());
const REPORT = { reports_receivables: ['read' as const], operations_billing: ['read' as const], operations_receipts: ['read' as const] };

describe('Receivables pages render for real (runtime regression guard)', () => {
  beforeEach(() => {
    uncaught.length = 0;
    window.addEventListener('error', onError);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener('error', onError);
    useAuthStore.setState({ user: null });
  });

  it('Summary: the KPI strip and the rows show the server figures; the totals row names what it totals', async () => {
    useAuthStore.setState({ user: user(REPORT) });
    await render('/modules/reports/receivables?asOf=2026-09-26');
    expect(uncaught).toEqual([]);
    expect(text()).toContain('₹28,456.71');
    expect(text()).toContain('Known Customer');
    expect(text()).toContain('₹11,000.00');
    expect(text()).toContain('Totals of the 1 customer listed');
    expect(text()).not.toMatch(/due date/i);
  });

  it('Aging: the bucket strip is the SCOPE (KPI) figures, not the searched table', async () => {
    useAuthStore.setState({ user: user(REPORT) });
    await render('/modules/reports/receivables?asOf=2026-09-26&tab=aging');
    expect(uncaught).toEqual([]);
    const strip = document.body.querySelector('[aria-label="Aging buckets"]')?.textContent ?? '';
    expect(strip).toContain('₹21,000.00');
    expect(strip).toContain('₹3,456.72');
    expect(strip).toContain('₹28,456.71');
  });

  it('Customer detail without Receipts Create: history shows the receipt once, and no Receive payment', async () => {
    useAuthStore.setState({ user: user(REPORT) });
    await render('/modules/reports/receivables/customers/9000000001?asOf=2026-09-26');
    expect(uncaught).toEqual([]);
    expect(text()).toContain('Payment history');
    expect(text()).toContain('₹23,000.00');
    expect(buttons().some((b) => b?.includes('Receive payment'))).toBe(false);
    expect(document.body.querySelectorAll('button[aria-label^="Receive payment for bill"]')).toHaveLength(0);
  });

  it('Customer detail with Receipts Create: Receive payment is offered for the customer and each unpaid bill', async () => {
    useAuthStore.setState({ user: user({ ...REPORT, operations_receipts: ['read', 'create'] }) });
    await render('/modules/reports/receivables/customers/9000000001?asOf=2026-09-26');
    expect(uncaught).toEqual([]);
    expect(buttons().some((b) => b?.includes('Receive payment'))).toBe(true);
    // Two bills still owe money (x2, x3); the paid one (x1) is hidden by default.
    expect(document.body.querySelectorAll('button[aria-label^="Receive payment for bill"]').length).toBeGreaterThanOrEqual(2);
  });
});
