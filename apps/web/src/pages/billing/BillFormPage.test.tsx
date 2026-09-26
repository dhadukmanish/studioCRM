// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, type AuthUser } from '@/store/auth';
import BillFormPage from './BillFormPage';

/**
 * Renders the REAL New Bill page — its imports, the auth store, the header, the line grid and the UI
 * kit — so a runtime-only failure fails here. Only the server is stubbed: two active books (one of
 * each series type) and the server's default-book answer, which picks the Without GST one.
 */

const BOOKS = [
  { id: 'b-gst', bookNumber: 'GST-2026-27', seriesType: 'WITH_GST' },
  { id: 'b-nogst', bookNumber: 'NON-GST-2026-27', seriesType: 'WITHOUT_GST' },
];
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: {
    get: vi.fn(async (url: string) => {
      if (url.startsWith('/api/common/lookups/books')) return BOOKS;
      if (url.startsWith('/api/bills/default-book')) return { bookId: 'b-nogst', reason: 'LAST_USED' };
      if (url.startsWith('/api/receipts/accounts')) return [{ id: 'acc-cash', accountName: 'CASH IN HAND', groupName: 'CASH' }];
      return [];
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    blob: vi.fn(),
  },
}));
vi.mock('@/lib/settings', () => ({
  useDateFormatters: () => ({ date: (v: string) => v, time: (v: string) => v, stamp: (v: string) => v, stampTime: (v: string) => v }),
  useDisplayFormats: () => ({ dateFormat: 'dd-MM-yyyy', timeFormat: 'hh:mm tt' }),
  useCompanyProfile: () => ({ data: null }),
  useCompanyLogo: () => ({ data: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user: AuthUser = {
  id: 'u1',
  tenantId: 't1',
  name: 'Tester',
  email: 'tester@test.local',
  roleId: 'r1',
  roleKey: null,
  roleName: 'Billing',
  isSuperAdmin: false,
  grants: { operations_billing: ['read', 'create', 'update'], operations_appointments: ['read'] },
  companyIds: [],
  branchIds: [],
};

let root: Root;
let host: HTMLDivElement;
const uncaught: unknown[] = [];
const onError = (e: ErrorEvent) => uncaught.push(e.error ?? e.message);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function renderNewBill() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/modules/billing/new']}>
          <Routes>
            <Route path="/modules/billing/new" element={<BillFormPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const text = () => document.body.textContent ?? '';
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const mobileInput = () => byLabel('Mobile number, 10 digits') as HTMLInputElement;
/** Type into a React-controlled input the way the browser does: set the value, fire `input`. */
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pasteInto(el: HTMLInputElement, pasted: string) {
  await act(async () => {
    el.focus();
    el.setSelectionRange(0, el.value.length);
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    ev.clipboardData = { getData: () => pasted };
    el.dispatchEvent(ev);
  });
}
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

describe('New Bill renders for real', () => {
  beforeEach(() => {
    uncaught.length = 0;
    window.addEventListener('error', onError);
    useAuthStore.setState({ user });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener('error', onError);
    useAuthStore.setState({ user: null });
  });

  it('opens on the server’s default book and shows the tax mode that book decides — read-only', async () => {
    await renderNewBill();
    expect(uncaught).toEqual([]);
    expect(text()).toContain('NON-GST-2026-27');
    // Tax Mode is a read-only value, not a toggle.
    expect(document.body.querySelector('[role="radiogroup"][aria-label="Tax mode"]')).toBeNull();
    expect(text()).toContain('Without GST');
    expect(text()).toContain('Auto-generated');
  });

  it('shows Planned Delivery, Baby Name and Next Visit Date directly — no More details, no helper clutter', async () => {
    await renderNewBill();
    for (const label of ['Planned Delivery', 'Baby Name', 'Next Visit Date', 'Remark', 'Birthdate']) expect(text()).toContain(label);
    expect(text()).toContain('Creates next appointment after saving');
    expect(text()).not.toMatch(/More details/i);
    expect(text()).not.toMatch(/Decides the bill number series/i);
    expect(text()).not.toMatch(/Issued by the book on save/i);
    expect(text()).not.toMatch(/GST-exclusive|GST exclusive/i);
  });

  it('mobile keeps digits only, at most ten, and sanitizes a pasted number', async () => {
    await renderNewBill();
    const input = mobileInput();
    expect(input.type).toBe('tel');
    expect(input.inputMode).toBe('numeric');
    expect(input.maxLength).toBe(10);
    await typeInto(input, '98765abc43210');
    expect(mobileInput().value).toBe('9876543210');
    await typeInto(mobileInput(), '98765432101');
    expect(mobileInput().value).toBe('9876543210');
    await typeInto(mobileInput(), 'abc');
    expect(mobileInput().value).toBe('');
    await pasteInto(mobileInput(), '+91 98765 43210');
    expect(mobileInput().value).toBe('9876543210');
  });

  it('each row has + immediately before Delete; + adds a line; the standalone Add line is gone', async () => {
    await renderNewBill();
    const add1 = byLabel('Add item after line 1');
    const remove1 = byLabel('Remove line 1');
    expect(add1?.tagName).toBe('BUTTON');
    expect(add1!.nextElementSibling).toBe(remove1);
    expect([...document.body.querySelectorAll('button')].some((b) => /^\s*Add line\s*$/i.test(b.textContent ?? ''))).toBe(false);

    await click(add1);
    expect(byLabel('Remove line 2')).not.toBeNull();
    expect(byLabel('Add item after line 2')).not.toBeNull();
  });

  it('the first line can always be added back after removing every line', async () => {
    await renderNewBill();
    await click(byLabel('Remove line 1'));
    expect(byLabel('Remove line 1')).toBeNull();
    const addFirst = [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Add item');
    expect(addFirst).toBeDefined();
    await click(addFirst!);
    expect(byLabel('Remove line 1')).not.toBeNull();
    expect(uncaught).toEqual([]);
  });

  it('without Receipts Create there is no Advance box — Billing alone never takes money', async () => {
    await renderNewBill();
    expect(byLabel('Advance received now')).toBeNull();
    expect(uncaught).toEqual([]);
  });

  it('Advance: payment fields appear only once an amount is typed; the only account is preselected; Due never touches Grand Total', async () => {
    useAuthStore.setState({ user: { ...user, grants: { ...user.grants, operations_receipts: ['read', 'create'] } } });
    await renderNewBill();
    const advance = byLabel('Advance received now') as HTMLInputElement;
    expect(advance).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Advance received via"]')).toBeNull();
    await typeInto(advance, '5000');
    await flush();
    expect(document.body.querySelector('[aria-label="Advance received via"]')).not.toBeNull();
    expect(text()).toContain('Received via');
    const accountSelect = [...document.body.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'acc-cash'));
    expect(accountSelect?.value).toBe('acc-cash');
    // An empty bill: Grand Total stays 0.00, the whole 5,000 is more than the bill.
    expect(text()).toMatch(/Grand Total₹0\.00/);
    expect(text()).toContain('more than the bill — kept as advance');
    await typeInto(advance, '');
    await flush();
    expect(document.body.querySelector('[aria-label="Advance received via"]')).toBeNull();
    expect(uncaught).toEqual([]);
  });
});
