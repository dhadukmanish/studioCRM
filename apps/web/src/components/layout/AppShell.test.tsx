// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, type AuthUser } from '@/store/auth';
import AppShell from './AppShell';

/**
 * The icon sidebar shows one entry per group the user may see (a group with no permitted page is
 * hidden), marks the group of the open page, and the group's pages appear as tabs above the page.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { get: async () => null, post: async () => null, blob: async () => null } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Asha Patel', firstName: 'Asha', email: 'a@test.local', roleId: 'r1', roleKey: null, roleName: 'Staff', isSuperAdmin: false, grants, companyIds: [], branchIds: [] } as AuthUser);

let host: HTMLDivElement;
let root: Root;
async function render(path: string, grants: AuthUser['grants']) {
  useAuthStore.setState({ user: user(grants) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<p>page body</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
const rail = () => [...host.querySelectorAll('nav[aria-label="Main"] a')].map((a) => ({ label: a.textContent, href: a.getAttribute('href'), current: a.getAttribute('aria-current') }));
const tabs = () => [...host.querySelectorAll('nav[aria-label$=" pages"] a')].map((a) => ({ label: a.textContent, active: a.getAttribute('aria-current') === 'page' }));
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState({ user: null });
});

describe('AppShell navigation', () => {
  it('shows only the permitted groups, each opening its first permitted page', async () => {
    await render('/dashboard', { operations_billing: ['read'], operations_receipts: ['read'], masters_books: ['read'] });
    expect(rail()).toEqual([
      { label: 'Dashboard', href: '/dashboard', current: 'true' },
      { label: 'Billing', href: '/modules/billing', current: null },
      { label: 'Masters', href: '/modules/masters/books', current: null },
    ]);
    expect(tabs()).toEqual([]); // the Dashboard group has a single page — no tab strip
  });

  it('marks the open page’s group and shows its pages as tabs, also on a detail page', async () => {
    await render('/modules/billing/abc-123', { operations_billing: ['read'], operations_receipts: ['read'], operations_work: ['read'] });
    expect(rail().find((r) => r.current === 'true')?.label).toBe('Billing');
    expect(tabs()).toEqual([{ label: 'Bills', active: true }, { label: 'Receipts', active: false }]);
    expect(host.textContent).toContain('page body');
  });

  it('keeps Work › Appointments apart from Reports › Appointments', async () => {
    await render('/modules/reports/appointments', { operations_appointments: ['read'], operations_work: ['read'] });
    expect(rail().find((r) => r.current === 'true')?.label).toBe('Reports');
    expect(tabs()).toEqual([{ label: 'Delivery', active: false }, { label: 'Appointments', active: true }]);
  });

  it('hides a tab the user may not open', async () => {
    await render('/modules/masters/items', { masters_items: ['read'], masters_books: ['read'] });
    expect(tabs().map((t) => t.label)).toEqual(['Items', 'Books']);
  });
});
