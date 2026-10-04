/**
 * The platform panel (the company that sells StudioCRM) and the studio app are ONE web build.
 * Which of them a browser gets is decided by the host name:
 *
 *   control.<domain>      -> platform panel only (no studio sign-in there)
 *   any other host        -> studio app only (no /platform routes)
 *   localhost, 127.0.0.1  -> both, so `http://localhost:5173/platform` works in development
 *
 * This is presentation only — the API refuses a studio token on platform routes and vice versa.
 */
export function isPlatformHost(hostname: string = window.location.hostname): boolean {
  return hostname.startsWith('control.');
}

export function isDevHost(hostname: string = window.location.hostname): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}
