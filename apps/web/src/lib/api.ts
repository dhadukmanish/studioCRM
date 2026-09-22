import { useAuthStore } from '@/store/auth';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: any,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
  const { accessToken, refreshToken, setTokens, logout } = useAuthStore.getState();
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  let res = await fetch(url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  if (res.status === 401 && refreshToken && !url.includes('/auth/')) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
    if (r.ok) {
      const j = await r.json();
      setTokens(j.data.accessToken, refreshToken, j.data.user);
      headers.authorization = `Bearer ${j.data.accessToken}`;
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    } else {
      logout();
    }
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? 'ERROR', e.message ?? res.statusText, res.status, e.details);
  }
  return (opts.raw ? json : json?.data) as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
  raw: <T>(method: string, url: string, body?: unknown) => request<T>(method, url, body, { raw: true }),
};

export function qs(params: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
