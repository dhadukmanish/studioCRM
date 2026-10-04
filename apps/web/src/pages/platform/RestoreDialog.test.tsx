// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_DISPLAY_FORMATS, FixedDisplayFormatsProvider } from '@/lib/settings';
import { usePlatformAuth } from '@/store/platformAuth';
import { RestoreDialog } from './RestoreDialog';
import type { StudioDetail } from './queries';

/**
 * The restore dialog replaces a studio's data, so its button stays disabled until all three are
 * true: the studio is suspended, a file is chosen, and the studio's name is typed exactly. The
 * upload goes to the platform restore endpoint as multipart with the platform token.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const studio = (isActive: boolean): StudioDetail => ({
  id: 's1', name: 'Asha Studio', slug: 'asha-studio', isActive, createdAt: '2026-09-01T10:00:00.000Z', userCount: 1, owner: null,
  access: { status: isActive ? 'ACTIVE' : 'SUSPENDED', endsOn: '2026-11-01', daysLeft: 28, readOnly: !isActive, blocked: !isActive },
  periods: [],
});

const posts: { url: string; body: unknown; auth: string | null }[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (init?.method === 'POST') {
    posts.push({ url, body: init.body, auth: new Headers(init.headers).get('authorization') });
    return json({ message: 'Studio data restored', data: { counts: {}, restoredFrom: '2026-10-01T00:00:00.000Z', usersWithoutPassword: 0 } });
  }
  return json({ message: 'ok', data: [] }); // snapshots
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function render(isActive: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FixedDisplayFormatsProvider value={DEFAULT_DISPLAY_FORMATS}>
          <RestoreDialog studio={studio(isActive)} open onClose={() => {}} />
        </FixedDisplayFormatsProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}
const button = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Replace data with backup')) as HTMLButtonElement;
async function chooseFile() {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['zip'], 'backup.zip', { type: 'application/zip' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function typeName(value: string) {
  const input = [...document.querySelectorAll('input')].find((i) => i.type !== 'file') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  usePlatformAuth.setState({ token: 'platform-token' } as never);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('RestoreDialog', () => {
  it('asks for suspension and keeps the button disabled while the studio is active', async () => {
    await render(true);
    expect(document.body.textContent).toContain('Suspend the studio first');
    await chooseFile();
    await typeName('Asha Studio');
    expect(button().disabled).toBe(true);
  });

  it('enables only with a file AND the exact studio name, then uploads with the platform token', async () => {
    await render(false);
    expect(button().disabled).toBe(true);
    await chooseFile();
    expect(button().disabled).toBe(true);
    await typeName('Asha');
    expect(button().disabled).toBe(true);
    await typeName('Asha Studio');
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/platform/studios/s1/restore');
    expect(posts[0].body).toBeInstanceOf(FormData);
    expect(posts[0].auth).toBe('Bearer platform-token');
  });
});
