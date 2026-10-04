// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePlatformAuth } from '@/store/platformAuth';
import PlatformApp from './PlatformApp';
import { cancellablePeriodId } from './StudioDetailPage';
import type { Period, PlatformSummary, Studio } from './queries';

/**
 * The platform Studios page over a stubbed fetch: it sends the PLATFORM token, draws the server's
 * summary and studio list (status label, dates in the default dd-MM-yyyy, days left), never touches
 * the studio API (no tenant settings), and a 401 ends the platform session back to its sign-in.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary: PlatformSummary = { today: '2026-10-04', total: 3, trial: 1, active: 1, grace: 0, expired: 1, suspended: 0, unmanaged: 0, expiringSoon: 1, revenueThisMonth: '12500.00' };
const studio = (over: Partial<Studio>): Studio => ({
  id: 's1', name: 'Asha Studio', slug: 'asha-studio', isActive: true, createdAt: '2026-09-01T10:00:00.000Z', userCount: 2,
  owner: { id: 'u1', name: 'Asha Patel', email: 'asha@test.local', mobile: '9876543210', lastLoginAt: null },
  access: { status: 'TRIAL', endsOn: '2026-10-08', daysLeft: 5, readOnly: false, blocked: false },
  ...over,
});
const studios = [studio({}), studio({ id: 's2', name: 'Ravi Films', slug: 'ravi-films', owner: null, access: { status: 'EXPIRED', endsOn: '2026-09-20', daysLeft: -14, readOnly: true, blocked: false } })];

let status401 = false;
const calls: { url: string; auth: string | null }[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (status401) return json(401, { error: { code: 'AUTH_002', message: 'Invalid or expired token' } });
  if (url === '/api/platform/summary') return json(200, { message: 'ok', data: summary });
  if (url.startsWith('/api/platform/studios')) return json(200, { message: 'ok', data: studios });
  if (url === '/api/platform/auth/me') return json(200, { message: 'ok', data: { id: 'a1', name: 'Platform Admin', email: 'p@test.local' } });
  return json(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/platform']}>
          <Routes><Route path="/platform/*" element={<PlatformApp />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return host.textContent ?? '';
}
const stat = (key: string) => host.querySelector(`[data-stat="${key}"]`)?.textContent;

beforeEach(() => {
  status401 = false;
  calls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  usePlatformAuth.setState({ token: 'platform-token', admin: { id: 'a1', name: 'Platform Admin', email: 'p@test.local' } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  usePlatformAuth.setState({ token: null, admin: null });
});

describe('Platform Studios page', () => {
  it('shows the server summary and every studio with its status, end date and days left', async () => {
    const text = await render();
    expect(stat('total')).toBe('3');
    expect(stat('expiringSoon')).toBe('1');
    expect(stat('revenueThisMonth')).toBe('₹12,500.00');
    const rows = [...host.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Asha Studio');
    expect(rows[0]).toContain('9876543210');
    expect(rows[0]).toContain('Trial');
    expect(rows[0]).toContain('08-10-2026');
    expect(rows[0]).toContain('5 days');
    expect(rows[1]).toContain('Expired');
    expect(rows[1]).toContain('No owner');
    expect(text).toContain('New studio');
  });

  it('calls only platform endpoints, always with the platform token', async () => {
    await render();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.startsWith('/api/platform/'))).toBe(true);
    expect(calls.every((c) => c.auth === 'Bearer platform-token')).toBe(true);
  });

  it('ends the platform session on a 401 and shows the platform sign-in', async () => {
    status401 = true;
    const text = await render();
    expect(usePlatformAuth.getState().token).toBeNull();
    expect(text).toContain('StudioCRM Platform');
    expect(host.querySelector('input[autocomplete="current-password"]')).not.toBeNull();
  });
});

describe('cancellablePeriodId', () => {
  const period = (over: Partial<Period>): Period => ({
    id: 'p', planId: 'pl', planName: 'Monthly', kind: 'MONTHLY', days: 30, startsOn: '2026-09-01', endsOn: '2026-09-30', amount: '999.00',
    paymentMode: 'CASH', paymentRef: null, paidOn: '2026-09-01', notes: null, status: 'ACTIVE', cancelledAt: null, cancelReason: null, createdAt: '2026-09-01T10:00:00.000Z', ...over,
  });

  it('offers Cancel only on the active period that ends last, ties going to the later one created', () => {
    expect(cancellablePeriodId([
      period({ id: 'a', endsOn: '2026-09-30' }),
      period({ id: 'b', endsOn: '2026-10-30', createdAt: '2026-09-02T10:00:00.000Z' }),
      period({ id: 'c', endsOn: '2026-10-30', createdAt: '2026-09-03T10:00:00.000Z' }),
      period({ id: 'd', endsOn: '2026-12-31', status: 'CANCELLED' }),
    ])).toBe('c');
    expect(cancellablePeriodId([period({ status: 'CANCELLED' })])).toBeNull();
  });
});
