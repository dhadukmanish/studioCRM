import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';

/**
 * Revoking public invoice links (docs/WHATSAPP_SHARING.md). Kept apart from
 * `publicInvoiceLinks.ts` and importing only the database layer, so the bill and template services
 * can call it inside their own transactions without an import cycle.
 */

const L = schema.publicInvoiceLinks;

/** `db`, or the transaction handle inside `db.transaction(...)`. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RevokeReason = 'BILL_UPDATED' | 'TEMPLATE_CHANGED' | 'REPLACED' | 'MANUAL' | 'STALE';

/**
 * Revokes the live link(s) of one bill, one template or one link, inside the caller's transaction,
 * and returns them (for the audit entry). A no-op when there is none.
 */
export async function revokeActiveLinks(exec: Executor, tenantId: string, target: { billId: string } | { templateId: string } | { linkId: string }, reason: RevokeReason) {
  const on = 'billId' in target ? eq(L.billId, target.billId) : 'templateId' in target ? eq(L.templateId, target.templateId) : eq(L.id, target.linkId);
  return exec
    .update(L)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(and(eq(L.tenantId, tenantId), on, isNull(L.revokedAt)))
    .returning({ id: L.id, billId: L.billId });
}
