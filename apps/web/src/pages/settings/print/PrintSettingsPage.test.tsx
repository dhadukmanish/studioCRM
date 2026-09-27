// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_PRINT_SETTINGS, legacyStudioTemplate } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import PrintSettingsPage from './PrintSettingsPage';

/**
 * Settings → Print & Invoice, rendered for real over a stubbed API. Pins the rule that caught a real
 * bug: the page must never let a Save send the DEFAULTS over the tenant's real settings — the form
 * shows the saved settings once they load, Save stays off until then, and an edit sends the saved
 * values plus that edit. Also: the live preview is the real invoice renderer, updated before Save.
 */

const saved = { ...DEFAULT_PRINT_SETTINGS, accent: 'TEAL', copyLabel: 'DUPLICATE', bank: { ...DEFAULT_PRINT_SETTINGS.bank, bankName: 'Saved Bank', ifsc: 'SBIN0001234' }, defaultDeliveryDays: 3 };
let releaseSettings: () => void = () => undefined;
const raw = vi.fn(async () => ({ message: 'Print settings saved', data: saved }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  api: {
    get: vi.fn(async (url: string) => {
      if (url === '/api/settings') return new Promise((resolve) => { releaseSettings = () => resolve({ dateFormat: 'dd/MM/yyyy', print: saved }); });
      if (url === '/api/settings/company') return { id: 'c1', name: 'Sunrise Studio', logo: null, signature: null, footerImage: null, legalName: null, taxId: null, email: null, phone: '98250 12345', website: null, addressLine1: 'Station Road', addressLine2: null, city: 'Rajkot', state: 'Gujarat', pincode: '360001', countryCode: 'IN', currency: 'INR' };
      if (url === '/api/settings/invoice-templates') return { rows: [{ id: 't-legacy', ...legacyStudioTemplate(), isActive: true, description: null, createdAt: '', updatedAt: '' }] };
      return null;
    }),
    raw: (...a: unknown[]) => raw(...(a as [])),
    blob: vi.fn(),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout: the invoice sheet's scale-to-fit observer is a no-op here.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const user: AuthUser = { id: 'u1', tenantId: 't1', name: 'Tester', email: 't@test.local', roleId: 'r1', roleKey: null, roleName: 'Admin', isSuperAdmin: false, grants: { settings_invoice_templates: ['read', 'update'] }, companyIds: [], branchIds: [] };

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const field = (label: string) => [...document.body.querySelectorAll('label.label')].find((l) => l.textContent?.trim() === label)?.parentElement?.querySelector('input') as HTMLInputElement;
const invoiceText = () => document.body.querySelector('.invoice-document')?.textContent ?? '';
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Print & Invoice settings page', () => {
  beforeEach(async () => {
    raw.mockClear();
    useAuthStore.setState({ user });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter><PrintSettingsPage /></MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useAuthStore.setState({ user: null });
  });

  it('never saves defaults over real settings: Save is off until they load, then the form shows them', async () => {
    expect(button('Save').disabled).toBe(true);
    await act(async () => releaseSettings());
    await flush();
    await act(async () => button('Payment').click());
    expect(field('Bank name').value).toBe('Saved Bank');
    expect(button('Save').disabled).toBe(true); // nothing edited yet
  });

  it('an edit enables Save and sends the saved settings plus that edit — and the preview shows it before saving', async () => {
    await act(async () => releaseSettings());
    await flush();
    await act(async () => button('Payment').click());
    await type(field('Account number'), '12345678901');
    expect(invoiceText()).toContain('12345678901');
    expect(invoiceText()).toContain('Saved Bank');
    expect(button('Save').disabled).toBe(false);
    await act(async () => button('Save').click());
    await flush();
    expect(raw).toHaveBeenCalledTimes(1);
    const [method, url, body] = raw.mock.calls[0] as unknown as [string, string, typeof saved];
    expect([method, url]).toEqual(['PUT', '/api/settings/print']);
    expect(body).toMatchObject({ accent: 'TEAL', copyLabel: 'DUPLICATE', defaultDeliveryDays: 3, bank: { bankName: 'Saved Bank', accountNumber: '12345678901', ifsc: 'SBIN0001234' } });
  });

  it('shows all four sections without a scrolling tab strip', async () => {
    await act(async () => releaseSettings());
    await flush();
    const tabs = [...document.body.querySelectorAll('[role=tab]')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Branding', 'Document', 'Payment', 'Templates']);
  });
});
