// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, type AuthUser } from '@/store/auth';
import { NextWorkAction, WorkSteps } from './WorkProgress';

/**
 * Renders the REAL step trail and next-action button — so a runtime-only break (a hook or helper
 * used but not imported) fails here, not on a staff member's screen — and pins the UX contract: ONE
 * primary action with a plain verb (Done / Done / Share / Delivered), WhatsApp only through the
 * share dialog, nothing to press for someone without Studio Work edit.
 */
vi.mock('@/components/invoice/ShareInvoiceDialog', () => ({ ShareInvoiceDialog: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Tester', email: 't@test.local', roleId: 'r1', roleKey: null, roleName: 'Test', isSuperAdmin: false, grants, companyIds: [], branchIds: [] });

let root: Root;
let host: HTMLDivElement;
async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
}
const primaries = () => [...host.querySelectorAll('button.btn-primary')];

describe('studio workflow on screen', () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useAuthStore.setState({ user: null });
  });

  it('the step trail spells out every state in text, not a mark alone', async () => {
    await render(<WorkSteps recorded={{ SELECTION: 'DONE', EDITING: 'SKIPPED' }} position="WHATSAPP" />);
    const text = host.textContent ?? '';
    expect(text).toContain('Selection: done');
    expect(text).toContain('Editing: skipped');
    expect(text).toContain('WhatsApp: next');
    expect(text).toContain('Delivery: to do');
  });

  it.each([
    ['SELECTION', 'Done', 'Selection done'],
    ['EDITING', 'Done', 'Editing done'],
    ['DELIVERY', 'Delivered', 'Mark delivered'],
  ] as const)('%s: exactly one primary button, "%s"', async (position, label, name) => {
    await render(<NextWorkAction billId="b1" position={position} canUpdate />);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].textContent?.trim()).toBe(label);
    expect(primaries()[0].getAttribute('aria-label')).toBe(name);
  });

  it('WhatsApp: the one button is Share (the share dialog records the step)', async () => {
    useAuthStore.setState({ user: user({ operations_billing: ['read'], operations_work: ['read', 'update'] }) });
    await render(<NextWorkAction billId="b1" position="WHATSAPP" canUpdate />);
    expect(primaries()).toHaveLength(1);
    expect(primaries()[0].textContent?.trim()).toBe('Share');
  });

  it('without Billing read WhatsApp cannot be shared from here — no primary, only ••• (skip)', async () => {
    useAuthStore.setState({ user: user({ operations_work: ['read', 'update'] }) });
    await render(<NextWorkAction billId="b1" position="WHATSAPP" canUpdate />);
    expect(primaries()).toHaveLength(0);
    expect(host.querySelector('[aria-label="More actions"]')).not.toBeNull();
  });

  it('without Studio Work edit nothing actionable is shown', async () => {
    await render(<NextWorkAction billId="b1" position="EDITING" canUpdate={false} />);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('uncommon actions live in ••• — Skip the current step, Mark the previous one pending', async () => {
    await render(<NextWorkAction billId="b1" position="EDITING" canUpdate />);
    await act(async () => (host.querySelector('[aria-label="More actions"]') as HTMLButtonElement).click());
    const items = host.textContent ?? '';
    expect(items).toContain('Skip Editing');
    expect(items).toContain('Mark Selection pending');
  });

  it('a finished job has no primary action; ••• can mark Delivery pending', async () => {
    await render(<NextWorkAction billId="b1" position="COMPLETE" canUpdate />);
    expect(primaries()).toHaveLength(0);
    await act(async () => (host.querySelector('[aria-label="More actions"]') as HTMLButtonElement).click());
    expect(host.textContent).toContain('Mark Delivery pending');
  });
});
