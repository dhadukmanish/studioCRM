// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DashboardSummary } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import DashboardPage from './DashboardPage';

/**
 * The Dashboard renders for real over a stubbed API: it draws exactly the sections the SERVER
 * returned (permissions are decided there), the period switch asks the server for that period, and
 * administration (users, roles, permissions) is not on it.
 */

const full: DashboardSummary = {
  period: 'THIS_MONTH', from: '2026-10-01', to: '2026-10-31', today: '2026-10-01',
  inquiries: { total: 12, pending: 5, done: 7, pendingToday: 2, overdue: 1 },
  orders: { total: 9, completed: 4, pending: 5, byPosition: { SELECTION: 2, EDITING: 1, WHATSAPP: 1, DELIVERY: 1, COMPLETE: 4 }, dueToday: 3, overdue: 2 },
  money: { billed: 45000, received: 30000, outstanding: 15000, totalOutstanding: 65625, billsWithOutstanding: 6, customersWithOutstanding: 4 },
};
let reply: DashboardSummary = full;
const get = vi.fn(async (url: string) => {
  if (url.startsWith('/api/dashboard')) return reply;
  if (url === '/api/settings') return { dateFormat: 'dd-MM-yyyy' };
  return null;
});
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { get: (url: string) => get(url) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Asha Patel', firstName: 'Asha', email: 'a@test.local', roleId: 'r1', roleKey: null, roleName: 'Staff', isSuperAdmin: false, grants, companyIds: [], branchIds: [] } as AuthUser);

let host: HTMLDivElement;
let root: Root;
let search = '';
function Where() {
  search = useLocation().search;
  return null;
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render(grants: AuthUser['grants'], data = full) {
  reply = data;
  get.mockClear();
  useAuthStore.setState({ user: user(grants) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/dashboard']}><DashboardPage /><Where /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return host.textContent ?? '';
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null });
});

describe('Dashboard', () => {
  it('shows inquiries, orders, the process status, payments and today’s attention — no admin shortcuts', async () => {
    const text = await render({ operations_appointments: ['read'], operations_billing: ['read'], operations_work: ['read'], reports_receivables: ['read'] });
    for (const s of ['Inquiries', 'Total inquiries', '12', 'Bill', 'Total orders', 'Completed', 'Order process status', 'Selection', 'Editing', 'WhatsApp', 'Delivery due', 'Payments', 'Total outstanding', '₹65,625.00', '6 bills · 4 customers', 'Appointments today', 'Deliveries due today', 'Overdue deliveries', '01-10-2026 – 31-10-2026']) {
      expect(text, s).toContain(s);
    }
    for (const s of ['Users', 'Roles', 'Permissions', 'Custom Fields']) expect(text, s).not.toContain(s);
    expect(get).toHaveBeenCalledWith('/api/dashboard?period=THIS_MONTH');
    // Each figure leads to the screen behind it.
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/modules/appointments', '/modules/billing', '/modules/reports/delivery', '/modules/reports/receivables', '/modules/work']));
  });

  it('draws only the sections the server returned', async () => {
    const text = await render({ operations_appointments: ['read'] }, { ...full, orders: undefined, money: undefined });
    expect(text).toContain('Total inquiries');
    for (const s of ['Total orders', 'Order process status', 'Total outstanding', 'Overdue deliveries']) expect(text, s).not.toContain(s);
  });

  it('switching the period asks the server for it and keeps it in the URL', async () => {
    await render({ operations_billing: ['read'] });
    const tab = (label: string) => [...host.querySelectorAll('[aria-label=Period] button')].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(tab('This month').getAttribute('aria-pressed')).toBe('true');
    await act(async () => tab('This FY').click());
    await flush();
    expect(search).toBe('?period=THIS_FY');
    expect(get).toHaveBeenCalledWith('/api/dashboard?period=THIS_FY');
    await act(async () => tab('Custom').click());
    await flush();
    // Custom starts from the range on screen, so it is never empty.
    expect(search).toContain('period=CUSTOM');
    expect(get).toHaveBeenCalledWith('/api/dashboard?period=CUSTOM&from=2026-10-01&to=2026-10-31');
    expect(host.textContent).toContain('Total orders');
  });

  it('an incomplete custom period asks for the dates instead of showing old figures', async () => {
    reply = full;
    get.mockClear();
    useAuthStore.setState({ user: user({ operations_billing: ['read'] }) });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/dashboard?period=CUSTOM&from=2026-10-05&to=2026-10-01']}><DashboardPage /></MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(host.textContent).toContain('The end date cannot be before the start date.');
    expect(host.textContent).not.toContain('Total orders');
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('/api/dashboard'));
  });

  it('a role with none of these modules gets a clear message, not an empty page', async () => {
    const text = await render({ masters_items: ['read'] }, { period: 'THIS_MONTH', from: '2026-10-01', to: '2026-10-31', today: '2026-10-01' });
    expect(text).toContain('there are no figures to show here');
  });
});
