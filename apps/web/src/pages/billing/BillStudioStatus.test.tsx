// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillWorkStatus } from '@erp/shared';
import { useAuthStore, type AuthUser } from '@/store/auth';
import { BillStudioStatus } from './BillStudioStatus';

/**
 * Renders the REAL Studio Status tracker and pins the manual-control contract: a pending step is one
 * click (in any order — no earlier step has to be faked), the recommended one is marked "next",
 * WhatsApp only through the real share dialog, a recorded step is corrected from its own menu, and
 * nothing is pressable without Studio Work edit or while the bill has unsaved changes.
 */
const mutate = vi.fn();
let work: BillWorkStatus;
vi.mock('@/lib/work', async (orig) => ({
  ...(await orig<typeof import('@/lib/work')>()),
  useBillWork: () => ({ data: work, isLoading: false, isError: false }),
  useWorkActions: () => ({ mutate, isPending: false }),
}));
vi.mock('@/components/invoice/ShareInvoiceDialog', () => ({ ShareInvoiceDialog: () => <div data-testid="share-dialog" /> }));
vi.mock('@/lib/settings', () => ({
  useDateFormatters: () => ({ date: (v: string) => v, time: (v: string) => v, stamp: (v: string) => v, stampTime: (v: string) => v }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (grants: AuthUser['grants']): AuthUser => ({ id: 'u1', tenantId: 't1', name: 'Tester', email: 't@test.local', roleId: 'r1', roleKey: null, roleName: 'Test', isSuperAdmin: false, grants, companyIds: [], branchIds: [] });
const STAFF = { operations_work: ['read', 'update'], operations_billing: ['read'] } as AuthUser['grants'];
const selectionDone: BillWorkStatus = {
  billId: 'b1',
  position: 'EDITING',
  plannedDelivery: '2026-09-30',
  stages: [{ stage: 'SELECTION', outcome: 'DONE', completedOn: '2026-09-26', completedAt: '2026-09-26T10:00:00Z', completedByName: 'Asha' }],
};

let root: Root;
let host: HTMLDivElement;
async function render(dirty = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><BillStudioStatus billId="b1" plannedDelivery="2026-09-30" dirty={dirty} /></QueryClientProvider>));
}
const chip = (start: string) => host.querySelector(`[aria-label^="${start}"]`) as HTMLElement | null;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());

describe('Studio Status on the bill', () => {
  beforeEach(() => {
    mutate.mockReset();
    work = selectionDone;
    useAuthStore.setState({ user: user(STAFF) });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    useAuthStore.setState({ user: null });
  });

  it('spells out every state and recommends the next step', async () => {
    await render();
    expect(chip('Selection: done')).not.toBeNull();
    expect(chip('Editing: next')).not.toBeNull();
    expect(chip('WhatsApp: not done')).not.toBeNull();
    expect(chip('Delivery: not done')).not.toBeNull();
    expect(host.textContent).toContain('Next: Editing');
    expect(host.textContent).toContain('Planned delivery 2026-09-30');
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
  });

  it('one click records the recommended step — no dialog, no Save', async () => {
    await render();
    await click(chip('Editing: next'));
    expect(mutate).toHaveBeenCalledWith({ type: 'record', billId: 'b1', stage: 'EDITING' });
  });

  it('any step can be recorded by hand, out of order — Delivery straight from here', async () => {
    await render();
    await click(chip('Delivery: not done'));
    expect(mutate).toHaveBeenCalledWith({ type: 'record', billId: 'b1', stage: 'DELIVERY' });
  });

  it('WhatsApp is never ticked: its chip opens the real share dialog', async () => {
    await render();
    await click(chip('WhatsApp: not done'));
    expect(mutate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="share-dialog"]')).not.toBeNull();
  });

  it('a recorded step is corrected from its own menu — who/when, then Mark pending', async () => {
    await render();
    await click(chip('Selection: done'));
    expect(host.textContent).toContain('Done 2026-09-26 · Asha');
    const markPending = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Mark Selection pending'));
    await click(markPending!);
    expect(mutate).toHaveBeenCalledWith({ type: 'reopen', billId: 'b1', stage: 'SELECTION' });
  });

  it('marking a delivery pending asks first', async () => {
    work = { ...selectionDone, position: 'COMPLETE', stages: [...selectionDone.stages, { stage: 'DELIVERY', outcome: 'DONE', completedOn: '2026-09-27', completedAt: '2026-09-27T10:00:00Z', completedByName: 'Asha' }] };
    await render();
    expect(host.textContent).toContain('Delivered 2026-09-27');
    await click(chip('Delivery: done'));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Mark Delivery pending'))!);
    expect(mutate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Mark delivery pending?');
  });

  it('without Studio Work edit: the states are shown, nothing is pressable', async () => {
    useAuthStore.setState({ user: user({ operations_work: ['read'] }) });
    await render();
    expect(chip('Editing: next')?.tagName).toBe('SPAN');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('with unsaved bill changes the steps wait for Save', async () => {
    await render(true);
    expect((chip('Editing: next') as HTMLButtonElement).disabled).toBe(true);
    expect(chip('Editing: next')?.getAttribute('title')).toBe('Save your changes first');
  });
});
