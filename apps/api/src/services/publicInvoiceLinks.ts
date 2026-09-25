import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PreparedPublicInvoiceLink, PublicInvoiceLinkState } from '@erp/shared';
import { db, schema } from '../db/client';
import { AppError, notFound, validation } from '../lib/errors';
import { getBillInvoice } from './invoice';
import { assertPrintable } from './invoicePdf';
import { logActivity } from './activity';
import { revokeActiveLinks, type RevokeReason } from './publicInvoiceLinkRevoke';
import type { FastifyRequest } from 'fastify';

export { revokeActiveLinks, type RevokeReason };

/**
 * Public invoice links — a customer opens a saved bill's invoice PDF from a URL in a WhatsApp
 * message, without logging in (docs/WHATSAPP_SHARING.md, Phase 5.1).
 *
 * The link is a CAPABILITY: whoever holds the URL may read that one invoice, nothing else. So:
 *
 *   - the token is unguessable — 192 bits of HMAC-SHA256 over the link's random id, keyed by a
 *     server secret (`PUBLIC_LINK_SECRET`) — and carries no bill id, number, tenant or customer;
 *   - only its SHA-256 is stored. A request is looked up by that hash and must also equal the token
 *     the CURRENT secret signs for that row (so rotating the secret revokes every link). The token
 *     can be REBUILT from the row id with the secret, which is what lets an unchanged re-share reuse
 *     the link the customer already has without the database ever holding a working URL;
 *   - at most ONE active link per bill (partial unique index + the bill row lock below);
 *   - a bill edit revokes it, in the bill's own transaction (`updateBill`), and a link also
 *     remembers the bill revision (`bills.updated_at`) it was made for: a mismatch is refused and
 *     revoked on sight, even if a revoke were ever missed;
 *   - a template edit, deactivation or delete revokes every live link on that template;
 *   - nothing here writes a bill, a line or a counter.
 */

const L = schema.publicInvoiceLinks;
const B = schema.bills;
const T = schema.invoiceTemplates;

/** `db`, or the transaction handle inside `db.transaction(...)`. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ------------------------------------------------------------------ tokens -- */

/** 24 bytes = 192 bits, base64url = exactly 32 URL-safe characters. */
const TOKEN_BYTES = 24;
export const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** The URL token of a link — a keyed PRF of its random id. Never stored, never logged. */
export const tokenFor = (secret: string, linkId: string) =>
  createHmac('sha256', secret).update(`studiocrm:public-invoice-link:v1:${linkId}`).digest().subarray(0, TOKEN_BYTES).toString('base64url');

/** What the database keeps instead of the token. */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time comparison of two tokens (both are checked to be 32 characters first). */
const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The signing secret, or null when the server has none worth using (then no link opens). */
const linkSecret = () => {
  const s = process.env.PUBLIC_LINK_SECRET ?? '';
  return s.length >= 32 ? s : null;
};

/** `/i/<token>` in a logged URL becomes `/i/[redacted]` — a full token must never reach a log. */
export const redactPublicToken = (url: string) => url.replace(/^\/i\/[^/?#]*/, '/i/[redacted]');

/* ------------------------------------------------------------------ config -- */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where links point and what signs them — both from the server's environment, NEVER from the
 * request's Host header (a forged Host would otherwise put an attacker's domain into a message
 * the studio sends to its customer).
 *
 *   PUBLIC_APP_URL      the canonical origin customers open, e.g. https://studio.kriviinfotech.com
 *                       — https required except for localhost
 *   PUBLIC_LINK_SECRET  32+ random characters; changing it INVALIDATES every issued link (each
 *                       request must carry the token the current secret signs) — by design, the
 *                       emergency way to revoke all links at once
 *
 * Read on every call, so a misconfigured server refuses to make links rather than making bad ones.
 */
export function publicLinkConfig(): { baseUrl: string; secret: string } {
  const notConfigured = () =>
    new AppError('PUBLIC_LINK_NOT_CONFIGURED', 'Invoice links are not set up on this server yet (PUBLIC_APP_URL / PUBLIC_LINK_SECRET). Ask the administrator.', 503);
  const secret = linkSecret();
  if (!secret) throw notConfigured();
  let u: URL;
  try {
    u = new URL(String(process.env.PUBLIC_APP_URL ?? '').trim());
  } catch {
    throw notConfigured();
  }
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
  // An ORIGIN only: `/i/:token` is served at the root, so a path here would make every link dead.
  if (!secure || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw notConfigured();
  return { baseUrl: u.origin, secret };
}

const linkUrl = (baseUrl: string, token: string) => `${baseUrl}/i/${token}`;

/* ------------------------------------------------------------- the bill's link -- */

/** The bill's live link, with whether it still matches the bill's revision. */
async function activeLink(exec: Executor, tenantId: string, billId: string) {
  const [row] = await exec
    .select({
      id: L.id,
      templateId: L.templateId,
      templateName: T.templateName,
      tokenHash: L.tokenHash,
      createdAt: L.createdAt,
      fresh: sql<boolean>`${L.billRevision} = ${B.updatedAt} and (${L.expiresAt} is null or ${L.expiresAt} > now())`,
    })
    .from(L)
    .innerJoin(B, and(eq(B.id, L.billId), eq(B.tenantId, L.tenantId)))
    .leftJoin(T, and(eq(T.id, L.templateId), eq(T.tenantId, L.tenantId)))
    .where(and(eq(L.tenantId, tenantId), eq(L.billId, billId), isNull(L.revokedAt)))
    .limit(1);
  return row ?? null;
}

async function assertBill(exec: Executor, tenantId: string, billId: string, lock = false) {
  const q = exec.select({ id: B.id, updatedAt: B.updatedAt }).from(B).where(and(eq(B.id, billId), eq(B.tenantId, tenantId))).limit(1);
  const [bill] = lock ? await q.for('update') : await q;
  if (!bill) throw notFound('Bill');
  return bill;
}

const NONE: PublicInvoiceLinkState = { active: false, url: null, templateId: null, templateName: null, createdAt: null };
const templateLabel = (id: string | null, name: string | null) => name ?? (id ? null : 'Classic (built-in)');

/**
 * What the Share dialog shows on opening: the bill's live link, if any. Creates nothing. A link
 * whose bill has moved on is revoked here (reason STALE) rather than shown.
 */
export async function getPublicLinkState(tenantId: string, billId: string): Promise<PublicInvoiceLinkState> {
  await assertBill(db, tenantId, billId);
  const link = await activeLink(db, tenantId, billId);
  if (!link) return NONE;
  if (!link.fresh) {
    await revokeActiveLinks(db, tenantId, { linkId: link.id }, 'STALE');
    return NONE;
  }
  const { baseUrl, secret } = publicLinkConfig();
  const token = tokenFor(secret, link.id);
  if (hashToken(token) !== link.tokenHash) {
    // Signed under a previous secret: it no longer opens, so it is not a live link any more.
    await revokeActiveLinks(db, tenantId, { linkId: link.id }, 'STALE');
    return NONE;
  }
  return {
    active: true,
    url: linkUrl(baseUrl, token),
    templateId: link.templateId,
    templateName: templateLabel(link.templateId, link.templateName),
    createdAt: link.createdAt.toISOString(),
  };
}

/**
 * Prepare the link a share sends: REUSE the bill's live link when it is for the same template and
 * the same bill revision (and its URL can be rebuilt), otherwise revoke it and make a new one.
 *
 * The template and the printability are checked first — exactly as the PDF download checks them —
 * so a share that could only ever open an error never creates a link. Then, under the bill's row
 * lock (the same lock `updateBill` takes), concurrent shares queue up: the first creates, the rest
 * reuse it, and a bill edit either lands before (the link is made for the new revision) or after
 * (it revokes the link) — never in between.
 */
export async function preparePublicLink(tenantId: string, billId: string, templateId?: string) {
  const { baseUrl, secret } = publicLinkConfig();
  const { model, billUpdatedAt } = await getBillInvoice(tenantId, billId, templateId);
  assertPrintable(model);
  const chosen = model.template.id;

  return db.transaction(async (tx) => {
    const bill = await assertBill(tx, tenantId, billId, true);
    // The checks above read the bill without the lock. If an edit landed in between they checked a
    // revision this link would not be for — refuse (fail closed) rather than publish an unchecked one.
    // Both sides are the same column read through a JS Date, so they compare to the millisecond.
    if (bill.updatedAt.getTime() !== billUpdatedAt.getTime()) throw new AppError('BILL_CHANGED', 'This bill was just changed — create the link again', 409);
    if (chosen) {
      // Held until commit: a template edit or delete (which revokes its links) either finishes
      // before this — and is seen here — or waits and then revokes the link made here.
      const [t] = await tx.select({ isActive: T.isActive }).from(T).where(and(eq(T.id, chosen), eq(T.tenantId, tenantId))).for('share');
      if (!t?.isActive) throw validation('That invoice template has just been changed — choose it again');
    }
    const current = await activeLink(tx, tenantId, billId);
    const revoked: { id: string; reason: RevokeReason }[] = [];
    if (current) {
      const token = tokenFor(secret, current.id);
      if (current.fresh && current.templateId === chosen && hashToken(token) === current.tokenHash) {
        const link: PreparedPublicInvoiceLink = {
          active: true,
          outcome: 'REUSED',
          url: linkUrl(baseUrl, token),
          templateId: current.templateId,
          templateName: templateLabel(current.templateId, current.templateName),
          createdAt: current.createdAt.toISOString(),
        };
        return { link, linkId: current.id, revoked };
      }
      const reason: RevokeReason = current.fresh ? 'REPLACED' : 'STALE';
      for (const r of await revokeActiveLinks(tx, tenantId, { linkId: current.id }, reason)) revoked.push({ id: r.id, reason });
    }

    const id = randomUUID();
    const token = tokenFor(secret, id);
    const [row] = await tx
      .insert(L)
      .values({
        id,
        tenantId,
        billId,
        templateId: chosen,
        tokenHash: hashToken(token),
        // Copied in SQL, not through JS: `updated_at` has microseconds a JS Date would drop.
        billRevision: sql`(select ${B.updatedAt} from ${B} where ${B.id} = ${billId} and ${B.tenantId} = ${tenantId})`,
      })
      .returning({ createdAt: L.createdAt });
    const link: PreparedPublicInvoiceLink = {
      active: true,
      outcome: 'CREATED',
      url: linkUrl(baseUrl, token),
      templateId: chosen,
      templateName: model.template.name,
      createdAt: row.createdAt.toISOString(),
    };
    return { link, linkId: id, revoked };
  });
}

/** The operator's "Revoke link": the URL stops working at once; nothing new is made. */
export async function revokePublicLink(tenantId: string, billId: string) {
  await assertBill(db, tenantId, billId);
  return (await revokeActiveLinks(db, tenantId, { billId }, 'MANUAL')).map((r) => r.id);
}

/* ------------------------------------------------------------ public access -- */

export interface OpenedPublicLink { linkId: string; tenantId: string; billId: string; templateId: string | null }

/**
 * The one lookup an anonymous request may make. Returns the link only when it is well-formed,
 * known, unrevoked, unexpired AND for the bill's current revision; everything else is `null`, so
 * the caller cannot tell unknown from revoked from stale. Cheap by design: no PDF work happens
 * before this says yes.
 */
export async function openPublicLink(token: string): Promise<OpenedPublicLink | null> {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({
      linkId: L.id,
      tenantId: L.tenantId,
      billId: L.billId,
      templateId: L.templateId,
      current: sql<boolean>`${L.billRevision} = ${B.updatedAt}`,
      expired: sql<boolean>`${L.expiresAt} is not null and ${L.expiresAt} <= now()`,
    })
    .from(L)
    .innerJoin(B, and(eq(B.id, L.billId), eq(B.tenantId, L.tenantId)))
    .where(and(eq(L.tokenHash, hashToken(token)), isNull(L.revokedAt)))
    .limit(1);
  if (!row || row.expired) return null;
  // The token must also be the one the CURRENT secret signs for this link. So rotating
  // PUBLIC_LINK_SECRET invalidates every issued URL at once — the emergency "revoke everything".
  // A server with no secret opens nothing (fails closed).
  const secret = linkSecret();
  if (!secret || !sameToken(tokenFor(secret, row.linkId), token)) return null;
  if (!row.current) {
    await revokeActiveLinks(db, row.tenantId, { linkId: row.linkId }, 'STALE');
    return null;
  }
  return { linkId: row.linkId, tenantId: row.tenantId, billId: row.billId, templateId: row.templateId };
}

/**
 * Re-checked AFTER rendering: a bill edit that committed while the PDF was being drawn has
 * revoked the link in the same transaction, so a PDF that might show the new figures under the
 * old URL is never sent.
 */
export async function isPublicLinkActive(linkId: string) {
  const rows = await db.select({ id: L.id }).from(L).where(and(eq(L.id, linkId), isNull(L.revokedAt))).limit(1);
  return rows.length > 0;
}

/* ------------------------------------------------------------------- audit -- */

const REVOKE_WHY: Record<RevokeReason, string> = {
  BILL_UPDATED: 'the bill was edited',
  TEMPLATE_CHANGED: 'its invoice template was changed',
  REPLACED: 'a new link replaced it',
  MANUAL: 'revoked by the operator',
  STALE: 'the bill had changed since it was made',
};

/**
 * One `invoice_public_link_revoked` entry per revoked link. The meta holds the link id and the
 * reason — never the token, its hash, the number or the message.
 */
export async function auditRevokedLinks(req: FastifyRequest, billId: string, documentLabel: string, linkIds: string[], reason: RevokeReason) {
  for (const linkId of linkIds) {
    await logActivity(req, 'bill', billId, 'invoice_public_link_revoked', `Invoice ${documentLabel} — public link revoked: ${REVOKE_WHY[reason]}`, { linkId, reason });
  }
}

/** "2026-27/1" — how an audit entry names the bill. */
export async function billDocumentLabel(tenantId: string, billId: string) {
  const [row] = await db
    .select({ bookNumber: schema.books.bookNumber, billNumber: B.billNumber })
    .from(B)
    .innerJoin(schema.books, eq(schema.books.id, B.bookId))
    .where(and(eq(B.id, billId), eq(B.tenantId, tenantId)))
    .limit(1);
  return row ? `${row.bookNumber}/${row.billNumber}` : billId;
}
