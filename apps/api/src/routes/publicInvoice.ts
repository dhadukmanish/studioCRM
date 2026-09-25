import type { FastifyInstance, FastifyReply } from 'fastify';
import { fixedWindowLimiter } from '../lib/rateLimit';
import { getBillInvoicePdf } from '../services/invoice';
import { isPublicLinkActive, openPublicLink } from '../services/publicInvoiceLinks';
import { revokeActiveLinks } from '../services/publicInvoiceLinkRevoke';
import { db } from '../db/client';

/**
 * The ONE anonymous invoice route: `GET /i/:token` — what a customer opens from WhatsApp
 * (docs/WHATSAPP_SHARING.md, Phase 5.1). No ERP session, no permission: the token is the
 * capability, and it grants exactly one invoice.
 *
 *   - Outside `/api/`, so it is never mistaken for (or routed through) the authenticated API, and
 *     short enough for a chat message. In production Node serves every path (IIS forwards all of
 *     them); in development Vite proxies `/i/` here.
 *   - The token is checked BEFORE any PDF work (and before the per-link rate limit): shape (no
 *     database), then one indexed lookup by its hash. Unknown, malformed, revoked, stale and
 *     expired links all get the same page and status, so the response says nothing about which.
 *   - A valid link streams the Phase 4 PDF inline — same renderer, same fonts, same file name.
 *   - Nothing here writes a bill, a line or a counter; the full token never reaches a log
 *     (`redactPublicToken` in server.ts, and errors are logged with the link id only).
 */

/**
 * PDF renders per VALID link per minute. Keyed by the link, not the client IP: behind IIS the IP is
 * either one shared address or a spoofable X-Forwarded-For, and a per-IP limit would let one person
 * lock every customer out. Invalid tokens are not counted — they cost one indexed lookup and no
 * rendering, and 192-bit tokens make guessing pointless. A customer opens an invoice a handful of
 * times; WhatsApp's link preview fetches it once more.
 */
const allow = fixedWindowLimiter({ limit: 30, windowMs: 60_000 });

const page = (title: string, message: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --card: #ffffff; --text: #1f2937; --muted: #6b7280; --line: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --text: #e5e7eb; --muted: #9ca3af; --line: #2a2e36; } }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; }
  main { max-width: 420px; margin: 18vh auto 0; padding: 0 16px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 22px 20px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><section><h1>${title}</h1><p>${message}</p></section></main></body>
</html>`;

// Fixed text only — nothing from the request is ever echoed into these pages.
const INVALID = page('Invoice link no longer valid', 'This invoice link is not available. The invoice may have been updated — please use the latest invoice link shared with you.');
const UNAVAILABLE = page('Invoice not available right now', 'This invoice cannot be shown at the moment. Please try again later, or contact the studio that sent it.');
const TOO_MANY = page('Please wait a moment', 'Too many requests. Please try again in a minute.');

function html(reply: FastifyReply, status: number, body: string) {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow')
    .send(body);
}

export async function publicInvoiceRoutes(app: FastifyInstance) {
  app.get('/i/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    let link: Awaited<ReturnType<typeof openPublicLink>>;
    try {
      link = await openPublicLink(token);
    } catch (err) {
      req.log.error({ err }, 'public invoice link lookup failed');
      return html(reply, 503, UNAVAILABLE);
    }
    if (!link) return html(reply, 404, INVALID);
    if (!allow(link.linkId)) return html(reply, 429, TOO_MANY);
    try {
      const { bytes, fileName, model } = await getBillInvoicePdf(link.tenantId, link.billId, link.templateId ?? undefined);
      // A link made with the built-in Classic must still be rendered by it, not by a template the
      // tenant added since — that link is over: revoke it so it is not rendered again.
      if (link.templateId === null && model.template.id !== null) {
        await revokeActiveLinks(db, link.tenantId, { linkId: link.linkId }, 'STALE');
        return html(reply, 404, INVALID);
      }
      // Re-checked after rendering: an edit that committed meanwhile revoked the link with it.
      if (!(await isPublicLinkActive(link.linkId))) return html(reply, 404, INVALID);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${fileName}"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('x-robots-tag', 'noindex, nofollow')
        .send(Buffer.from(bytes));
    } catch (err) {
      // Unprintable text, an inactive template, a renderer fault: the customer gets a calm page;
      // the log gets the link id — never the token.
      req.log.warn({ err, linkId: link.linkId }, 'public invoice link could not be rendered');
      return html(reply, 503, UNAVAILABLE);
    }
  });
}
