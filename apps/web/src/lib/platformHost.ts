/**
 * The platform panel (the company that sells StudioCRM) and the studio app are ONE web build. The
 * panel lives at /platform/* on every host. A host whose name starts with `control.` and serves
 * this build itself shows ONLY the panel. Live, control.kriviinfotech.com is a separate hosting
 * site that redirects to https://studio.kriviinfotech.com/platform (deploy/control-redirect/web.config),
 * because the host cannot bind a second domain to a subdomain site.
 *
 * This is presentation only — the API refuses a studio token on platform routes and vice versa.
 */
export function isPlatformHost(hostname: string = window.location.hostname): boolean {
  return hostname.startsWith('control.');
}
