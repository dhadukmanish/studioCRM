// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, type AuthUser } from '@/store/auth';
import { ShareInvoiceDialog } from './ShareInvoiceDialog';

/**
 * Renders the REAL ShareInvoiceDialog — its real imports, the real auth store and the real UI kit —
 * so a hook or helper it uses but does not import (a ReferenceError at render) fails here, not in a
 * user's browser. Only the network hooks are stubbed, with a bill that already has a live link, so
 * the one permission-gated control (manual "Revoke link", Billing UPDATE) is on screen.
 */

vi.mock('@/lib/invoice', () => ({
  useInvoiceShare: () => ({
    data: {
      transport: 'WHATSAPP_CLICK_TO_CHAT',
      customerName: 'Test Customer',
      mobileNumber: '98765 43210',
      taxMode: 'WITH_GST',
      documentLabel: '2026-27 / 7',
      grandTotal: '₹1,180.00',
      fileName: 'Invoice-2026-27-7.pdf',
      message: 'Hello, your invoice:\n{InvoiceLink}',
    },
    isLoading: false,
    error: null,
  }),
  usePublicInvoiceLink: () => ({
    data: { active: true, url: 'https://studio.example.com/i/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', templateId: 'tpl-1', templateName: 'Classic', createdAt: '2026-09-25T10:00:00.000Z' },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useInvoiceTemplateLookup: () => ({ data: [{ id: 'tpl-1', templateName: 'Classic', supportedMode: 'BOTH', isDefault: true }] }),
  preparePublicInvoiceLink: vi.fn(),
  revokePublicInvoiceLink: vi.fn(),
  recordInvoiceShareOpened: vi.fn(),
}));
vi.mock('@/lib/settings', () => ({ useDateFormatters: () => ({ stampTime: (v: string) => v }) }));

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

async function renderDialog() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ShareInvoiceDialog billId="bill-1" open onClose={() => {}} />
      </QueryClientProvider>,
    );
  });
}
const buttons = () => [...document.body.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('ShareInvoiceDialog renders for real (runtime regression guard)', () => {
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

  it('Billing read-only: the dialog renders, the link is shown, and manual Revoke is NOT offered', async () => {
    useAuthStore.setState({ user: user({ operations_billing: ['read'] }) });
    await renderDialog();
    expect(uncaught).toEqual([]);
    expect(document.body.textContent).toContain('Share invoice on WhatsApp');
    expect(document.body.textContent).toContain('Invoice link ready');
    expect(document.body.querySelector('a[href^="https://wa.me/919876543210"]')).not.toBeNull();
    expect(buttons()).not.toContain('Revoke link');
  });

  it('Billing update: the dialog renders and manual Revoke IS offered', async () => {
    useAuthStore.setState({ user: user({ operations_billing: ['read', 'update'] }) });
    await renderDialog();
    expect(uncaught).toEqual([]);
    expect(document.body.textContent).toContain('Invoice link ready');
    expect(buttons()).toContain('Revoke link');
  });
});
