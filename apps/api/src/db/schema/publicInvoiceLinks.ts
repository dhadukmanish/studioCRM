import { pgTable, uuid, text, timestamp, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, tenantRef } from './core';
import { bills } from './bills';
import { invoiceTemplates } from './invoiceTemplates';

/**
 * A public invoice link — the capability a customer uses to open a bill's invoice PDF without
 * logging in (`/i/<token>`, docs/WHATSAPP_SHARING.md, Phase 5.1).
 *
 * The raw token is NEVER stored: only its SHA-256 (`token_hash`), which is what a request is
 * looked up by. The token itself is rebuilt from this row's id with a server-held secret
 * (`services/publicInvoiceLinks.ts`), so a database leak alone yields no working URL.
 *
 * Deliberately holds no customer data — no name, no mobile, no message. The bill stays the one
 * source of what the invoice says.
 *
 * Lifecycle: created by a Share; revoked (never deleted) by a bill edit, a template edit, a share
 * with another template, or the operator. At most ONE active (unrevoked) link per bill — backed by
 * `public_invoice_links_one_active_idx`, not only by the service.
 */
export const publicInvoiceLinks = pgTable(
  'public_invoice_links',
  {
    id: id(),
    tenantId: tenantRef(),
    billId: uuid('bill_id').notNull(),
    /** The template the link renders with. NULL = the built-in Classic (a tenant with no compatible template). */
    templateId: uuid('template_id'),
    /** Lowercase hex SHA-256 of the URL token. */
    tokenHash: text('token_hash').notNull(),
    /**
     * `bills.updated_at` when the link was made. A link whose bill has moved on is refused even if
     * its revocation were somehow missed — defence in depth behind the revoke in `updateBill`.
     */
    billRevision: timestamp('bill_revision', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** Not used yet: links live until revoked. Here so an expiry can be added without a migration. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** BILL_UPDATED | TEMPLATE_CHANGED | REPLACED | MANUAL | STALE */
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    /** The lookup every public request makes, and a guard against a (practically impossible) collision. */
    uniqueIndex('public_invoice_links_token_hash_idx').on(t.tokenHash),
    /** The one-active-link rule, enforced by the database: two racing shares cannot both leave a live link. */
    uniqueIndex('public_invoice_links_one_active_idx').on(t.tenantId, t.billId).where(sql`${t.revokedAt} is null`),
    /** Revoking every live link of an edited template. */
    index('public_invoice_links_tenant_template_idx').on(t.tenantId, t.templateId),
    /** Tenant-safe: a link can only point at a bill of its own tenant. It goes with the bill. */
    foreignKey({ columns: [t.billId, t.tenantId], foreignColumns: [bills.id, bills.tenantId], name: 'public_invoice_links_bill_tenant_fk' }).onDelete('cascade'),
    /**
     * Same for the template; NULL (built-in) passes. CASCADE rather than RESTRICT: deleting a
     * template first revokes its live links (in the same transaction) and then takes the rows with
     * it, so no URL can outlive its template.
     */
    foreignKey({ columns: [t.templateId, t.tenantId], foreignColumns: [invoiceTemplates.id, invoiceTemplates.tenantId], name: 'public_invoice_links_template_tenant_fk' }).onDelete('cascade'),
    check('public_invoice_links_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('public_invoice_links_revoke_reason_check', sql`${t.revokeReason} in ('BILL_UPDATED', 'TEMPLATE_CHANGED', 'REPLACED', 'MANUAL', 'STALE')`),
    // Revoked and a reason, or neither.
    check('public_invoice_links_revoked_pair_check', sql`(${t.revokedAt} is null) = (${t.revokeReason} is null)`),
  ],
);
