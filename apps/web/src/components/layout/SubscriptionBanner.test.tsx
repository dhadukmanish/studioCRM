// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubscriptionAccess } from '@erp/shared';
import { SubscriptionBanner } from './SubscriptionBanner';

/**
 * The studio's subscription strip: it warns in the last week of a trial or plan, counts the grace
 * days left, says read-only once expired — dates in the tenant's format — and stays away otherwise.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { get: async (url: string) => (url === '/api/settings' ? { dateFormat: 'dd/MM/yyyy' } : null) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const access = (over: Partial<SubscriptionAccess>): SubscriptionAccess => ({ status: 'ACTIVE', endsOn: '2026-10-10', daysLeft: 30, readOnly: false, blocked: false, ...over });

let host: HTMLDivElement;
let root: Root;
async function render(a: SubscriptionAccess | undefined) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SubscriptionBanner access={a} /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host.textContent ?? '';
}
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('SubscriptionBanner', () => {
  it('warns in the last days of a trial, in the tenant date format', async () => {
    expect(await render(access({ status: 'TRIAL', daysLeft: 3 }))).toBe('Your trial ends on 10/10/2026 — 3 days left. Contact your provider to renew.');
  });

  it('says "1 day" on the last day of a paid plan', async () => {
    expect(await render(access({ status: 'ACTIVE', daysLeft: 1 }))).toContain('Your subscription ends on 10/10/2026 — 1 day left.');
  });

  it('counts the grace days still left before read-only', async () => {
    // daysLeft -1 = the second day past the last paid day; grace is 3 days → 2 left.
    const text = await render(access({ status: 'GRACE', daysLeft: -1 }));
    expect(text).toBe('Your subscription ended on 10/10/2026. Renew within 2 days to avoid read-only mode.');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it('says read-only once expired, as an alert', async () => {
    expect(await render(access({ status: 'EXPIRED', daysLeft: -9, readOnly: true }))).toBe('Subscription expired on 10/10/2026 — the account is read-only. You can still view and print.');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows nothing with days to spare, for an unmanaged studio, or before the user is known', async () => {
    expect(await render(access({ status: 'ACTIVE', daysLeft: 8 }))).toBe('');
    await act(async () => root.unmount());
    host.remove();
    expect(await render(access({ status: 'UNMANAGED', endsOn: null, daysLeft: null }))).toBe('');
    await act(async () => root.unmount());
    host.remove();
    expect(await render(undefined)).toBe('');
  });
});
