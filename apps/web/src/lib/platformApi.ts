import { createApiClient, requestInit } from '@/lib/api';
import { usePlatformAuth } from '@/store/platformAuth';

/**
 * The platform panel's API client: the same request/envelope/error handling as the studio `api`,
 * with the platform token. No refresh — any 401 (other than a failed sign-in) ends the session and
 * the panel's layout sends the admin to /platform/signin.
 */
export const platformApi = createApiClient(
  (method, url, body) => fetch(url, requestInit(method, body, usePlatformAuth.getState().token)),
  (e, url) => {
    if (e.status === 401 && !url.endsWith('/api/platform/auth/login')) usePlatformAuth.getState().logout();
  },
);
