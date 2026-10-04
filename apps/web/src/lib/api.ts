import { useAuthStore } from '@/store/auth';
import { toast } from '@/lib/toast';

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

/* ---------------------------------------------------------------------------------------------
 * Shared plumbing. Two clients use it: the studio client below (`api`) and the platform panel's
 * (`lib/platformApi.ts`). They differ only in how a request is SENT (which token, whether a 401
 * can be refreshed) and what an error triggers; the request body, the `{ message, data }`
 * envelope and the `{ error: { code, message, details } }` error shape are the same API.
 * ------------------------------------------------------------------------------------------- */

/** fetch() options for one call: JSON body (or FormData as is) and an optional Bearer token. */
export function requestInit(method: string, body: unknown, token: string | null | undefined): RequestInit {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  return { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) };
}

export async function toApiError(res: Response) {
  let e: any = {};
  try {
    e = (await res.json())?.error ?? {};
  } catch {}
  return new ApiError(e.code ?? 'ERROR', e.message ?? res.statusText, res.status, e.details);
}

type Send = (method: string, url: string, body?: unknown) => Promise<Response>;

/** An API client over one `send`. `onError` sees every failed call before it is thrown. */
export function createApiClient(send: Send, onError?: (e: ApiError, url: string) => void) {
  const fail = async (res: Response, url: string) => {
    const e = await toApiError(res);
    onError?.(e, url);
    return e;
  };
  async function request<T>(method: string, url: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
    const res = await send(method, url, body);
    if (!res.ok) throw await fail(res, url);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return (opts.raw ? json : json?.data) as T;
  }
  return {
    get: <T>(url: string) => request<T>('GET', url),
    post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
    put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
    patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
    delete: <T>(url: string) => request<T>('DELETE', url),
    raw: <T>(method: string, url: string, body?: unknown) => request<T>(method, url, body, { raw: true }),
    /** A binary response (an image), with the same auth and error handling as every other call. */
    blob: async (url: string) => {
      const res = await send('GET', url);
      if (!res.ok) throw await fail(res, url);
      return res.blob();
    },
  };
}

/* ------------------------------------------------------------------------------ studio client -- */

/** One authenticated fetch, refreshing the access token once on a 401. */
async function send(method: string, url: string, body?: unknown): Promise<Response> {
  const { accessToken, refreshToken, setTokens, logout } = useAuthStore.getState();
  let res = await fetch(url, requestInit(method, body, accessToken));
  if (res.status === 401 && refreshToken && !url.includes('/auth/')) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
    if (r.ok) {
      const j = await r.json();
      setTokens(j.data.accessToken, refreshToken, j.data.user);
      res = await fetch(url, requestInit(method, body, j.data.accessToken));
    } else {
      logout();
    }
  }
  return res;
}

/**
 * A suspended studio (403 SUB_003) is refused on every call: end the session, which sends the
 * operator to /signin through the Protected route, and say why once.
 */
function onStudioError(e: ApiError) {
  if (e.status !== 403 || e.code !== 'SUB_003') return;
  const { accessToken, logout } = useAuthStore.getState();
  if (!accessToken) return; // the sign-in page shows this error itself; parallel calls toast once
  logout();
  toast.error(e.message);
}

export const api = createApiClient(send, onStudioError);

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
