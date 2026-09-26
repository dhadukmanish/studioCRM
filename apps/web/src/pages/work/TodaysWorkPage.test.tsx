// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkQueue, WorkQueueItem } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import TodaysWorkPage from './TodaysWorkPage';

/**
 * Renders the REAL Today's Work page (its imports, the auth store, the UI kit) with only the server
 * stubbed, and pins what a new employee sees: each row names the ONE current step with ONE button
 * for it, money in plain words (Due / Paid / Advance), and a calm "all caught up" when there is
 * nothing to do. Figures are shown as the server sent them — the page never re-adds money.
 */
vi.mock('@/components/invoice/ShareInvoiceDialog', () => ({ ShareInvoiceDialog: () => null }));
vi.mock('@/lib/settings', () => ({
  useDateFormatters: () => ({ date: (v: string) => v, time: (v: string) => v, stamp: (v: string) => v, stampTime: (v: string) => v }),
  useDisplayFormats: () => ({ dateFormat: 'dd-MM-yyyy', timeFormat: 'hh:mm tt' }),
}));
let queue: WorkQueue;
vi.mock('@/lib/work', async (orig) => ({
  ...(await orig<typeof import('@/lib/work')>()),
  useWorkQueue: () => ({ data: queue, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = '2026-09-26';
const item = (over: Partial<WorkQueueItem>): WorkQueueItem => ({
  kind: 'BILL',
  id: 'x',
  reference: '2026-27/5',
  customerName: 'Riya Patel',
  mobileNumber: '9876500001',
  babyName: null,
  next: 'SELECTION',
  dueDate: TODAY,
  dueTime: null,
  overdue: false,
  billDate: TODAY,
  plannedDelivery: null,
  completedAt: null,
  deliveryOutcome: null,
  mobileSearch: '9876500001',
  paymentStatus: 'UNPAID',
  outstandingAmount: 5000,
  availableAdvance: 0,
  advanceToApply: 0,
  ...over,
});
const withRows = (rows: WorkQueueItem[], counts = { TODAY: rows.length, PENDING: rows.length, UPCOMING: 0, COMPLETED: 0 }): WorkQueue => ({ today: TODAY, view: 'TODAY', searchedAllPending: false, rows, total: rows.length, page: 1, pageSize: 50, counts });

const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Tester', email: 't@test.local', roleId: 'r1', roleKey: null, roleName: 'Test', isSuperAdmin: false, grants, companyIds: [], branchIds: [] });
const STAFF = { operations_work: ['read', 'update'], operations_billing: ['read'], operations_appointments: ['read', 'update'], operations_receipts: ['read', 'create'] } as AuthUser['grants'];

let root: Root;
let host: HTMLDivElement;
async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TodaysWorkPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}
const rowsEl = () => [...host.querySelectorAll('ul > li')];
const primaryIn = (li: Element) => [...li.querySelectorAll('button.btn-primary')].map((b) => b.textContent?.trim());

describe("Today's Work", () => {
  beforeEach(() => useAuthStore.setState({ user: user(STAFF) }));
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useAuthStore.setState({ user: null });
  });

  it('each row shows ONE current step and ONE button for it', async () => {
    queue = withRows([
      item({ id: 'a1', kind: 'APPOINTMENT', reference: '#7', customerName: 'Meera Shah', next: 'APPOINTMENT', dueTime: '11:30', billDate: null, paymentStatus: null, outstandingAmount: null }),
      item({ id: 'b1', next: 'SELECTION' }),
      item({ id: 'b2', next: 'EDITING' }),
      item({ id: 'b3', next: 'WHATSAPP' }),
      item({ id: 'b4', next: 'DELIVERY', plannedDelivery: TODAY }),
    ]);
    await render();
    const rows = rowsEl();
    expect(rows).toHaveLength(5);
    expect(rows.map(primaryIn)).toEqual([['Done'], ['Done'], ['Done'], ['Share'], ['Delivered']]);
    expect(rows[0].textContent).toContain('Appointment · 11:30');
    expect(rows[1].textContent).toContain('Selection');
    expect(rows[1].textContent).not.toMatch(/Editing|WhatsApp|Delivery/);
    expect(rows[4].textContent).toContain('Due today');
  });

  it('money in plain words: Due, Paid, Advance — never allocation terms', async () => {
    queue = withRows([
      item({ id: 'b1', outstandingAmount: 5000, availableAdvance: 3000, advanceToApply: 3000 }),
      item({ id: 'b2', outstandingAmount: 0, paymentStatus: 'PAID' }),
      item({ id: 'a1', kind: 'APPOINTMENT', next: 'APPOINTMENT', paymentStatus: null, outstandingAmount: null, availableAdvance: 2000 }),
    ]);
    await render();
    const [b1, b2, a1] = rowsEl().map((r) => r.textContent ?? '');
    expect(b1).toMatch(/5,000\.00 Due/);
    expect(b1).toMatch(/3,000\.00 Advance/);
    expect(b2).toContain('Paid');
    expect(a1).toMatch(/2,000\.00 Advance/);
    expect(host.textContent).not.toMatch(/allocat|unallocated|outstanding/i);
  });

  it('a Delivery with money Due still offers Delivered', async () => {
    queue = withRows([item({ id: 'b1', next: 'DELIVERY', outstandingAmount: 2500, paymentStatus: 'PARTIALLY_PAID' })]);
    await render();
    expect(primaryIn(rowsEl()[0])).toEqual(['Delivered']);
    expect(rowsEl()[0].textContent).toMatch(/2,500\.00 Due/);
  });

  it('without Studio Work edit or Appointments edit there is no button to press', async () => {
    useAuthStore.setState({ user: user({ operations_work: ['read'], operations_appointments: ['read'] }) });
    queue = withRows([item({ id: 'b1' }), item({ id: 'a1', kind: 'APPOINTMENT', next: 'APPOINTMENT', paymentStatus: null, outstandingAmount: null })]);
    await render();
    expect(rowsEl().flatMap(primaryIn)).toEqual([]);
  });

  it('nothing to do today: a calm all-caught-up message, not an empty grid', async () => {
    queue = withRows([], { TODAY: 0, PENDING: 12, UPCOMING: 3, COMPLETED: 40 });
    await render();
    expect(host.textContent).toContain("You're all caught up for today.");
    expect(host.textContent).toContain('View upcoming work');
    expect(host.querySelector('ul')).toBeNull();
  });
  it('a skipped Delivery never reads "Delivered"', async () => {
    queue = { ...withRows([item({ id: 'b1', next: 'COMPLETE', deliveryOutcome: 'SKIPPED', completedAt: '2026-09-26T10:00:00Z' }), item({ id: 'b2', next: 'COMPLETE', deliveryOutcome: 'DONE', completedAt: '2026-09-26T09:00:00Z' })]), view: 'COMPLETED' };
    await render();
    const [skipped, delivered] = rowsEl().map((r) => r.textContent ?? '');
    expect(skipped).toContain('Delivery not needed');
    expect(skipped).not.toContain('Delivered');
    expect(delivered).toContain('Delivered');
  });

  it('without Billing or Receipts read: no money on the rows — and never a false "Paid"', async () => {
    useAuthStore.setState({ user: user({ operations_work: ['read', 'update'] }) });
    queue = withRows([item({ id: 'b1', paymentStatus: null, outstandingAmount: null })]);
    await render();
    expect(rowsEl()[0].textContent).not.toMatch(/Due|Paid|Advance|₹/);
    expect(primaryIn(rowsEl()[0])).toEqual(['Done']);
  });
});
