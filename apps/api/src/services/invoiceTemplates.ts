import { and, asc, count, desc, eq, ne, sql } from 'drizzle-orm';
import {
  BUILT_IN_INVOICE_TEMPLATE,
  INVOICE_TEMPLATE_LIMITS,
  isTemplateCompatible,
  pickInvoiceTemplate,
  starterInvoiceTemplates,
  INVOICE_TAX_MODE_LABELS,
  type InvoiceTaxMode,
  type InvoiceTemplateInput,
  type InvoiceTemplateMode,
  type InvoiceLayoutPreset,
  type InvoiceTemplateSource,
} from '@erp/shared';
import { db, schema, type Db } from '../db/client';
import { notFound, validation } from '../lib/errors';

/**
 * Invoice Template Master — business rules (docs/INVOICE_TEMPLATES.md).
 *
 *   - one default per tenant: moved only by `setDefaultTemplate`, in one transaction, and backed
 *     by the partial unique index `invoice_templates_one_default_idx`;
 *   - the default cannot be deleted or deactivated — make another template the default first;
 *   - starter templates are seeded once per tenant (a tenant with zero templates has never been
 *     seeded, because the default can never be deleted) and never overwritten;
 *   - nothing references a template, so no delete can reach a bill.
 */

const T = schema.invoiceTemplates;
type Row = typeof T.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** API shape: the enum columns typed as their unions. */
export const shapeTemplate = (r: Row) => ({ ...r, supportedMode: r.supportedMode as InvoiceTemplateMode, layoutPreset: r.layoutPreset as InvoiceLayoutPreset });
export type InvoiceTemplateRecord = ReturnType<typeof shapeTemplate>;

/**
 * Creates the starter templates for a tenant that has none. Idempotent and race-safe: two
 * concurrent first requests both try, and the unique indexes (name, single default) make the
 * second insert a no-op rather than a duplicate. A tenant's own templates are never touched.
 */
export async function ensureStarterTemplates(tenantId: string, exec: Db = db) {
  const [{ n }] = await exec.select({ n: count() }).from(T).where(eq(T.tenantId, tenantId));
  if (Number(n) > 0) return;
  for (const s of starterInvoiceTemplates()) {
    await exec.insert(T).values({ tenantId, ...s }).onConflictDoNothing();
  }
}

export async function listTemplates(tenantId: string) {
  await ensureStarterTemplates(tenantId);
  const rows = await db.select().from(T).where(eq(T.tenantId, tenantId)).orderBy(desc(T.isDefault), asc(sql`lower(${T.templateName})`));
  return rows.map(shapeTemplate);
}

export async function getTemplate(tenantId: string, id: string) {
  if (!isUuid(id)) throw notFound('Invoice template');
  const [row] = await db.select().from(T).where(and(eq(T.tenantId, tenantId), eq(T.id, id)));
  if (!row) throw notFound('Invoice template');
  return shapeTemplate(row);
}

async function assertNameFree(tenantId: string, name: string, exceptId?: string) {
  const [clash] = await db
    .select({ id: T.id })
    .from(T)
    .where(and(eq(T.tenantId, tenantId), sql`lower(${T.templateName}) = lower(${name})`, exceptId ? ne(T.id, exceptId) : undefined));
  if (clash) throw validation(`A template named "${name}" already exists`, [{ path: 'templateName', message: 'This name is already used by another template' }]);
}

export async function createTemplate(tenantId: string, body: InvoiceTemplateInput) {
  await ensureStarterTemplates(tenantId);
  await assertNameFree(tenantId, body.templateName);
  const [row] = await db.insert(T).values({ tenantId, ...body, isDefault: false }).returning();
  return shapeTemplate(row);
}

export async function updateTemplate(tenantId: string, id: string, body: InvoiceTemplateInput) {
  const existing = await getTemplate(tenantId, id);
  if (existing.isDefault && !body.isActive) throw validation('The default template cannot be made inactive — make another template the default first');
  await assertNameFree(tenantId, body.templateName, id);
  const [row] = await db.update(T).set({ ...body, updatedAt: new Date() }).where(and(eq(T.tenantId, tenantId), eq(T.id, id))).returning();
  return { previous: existing, template: shapeTemplate(row) };
}

/** Makes one template the tenant default — clears the old one first, in the same transaction. */
export async function setDefaultTemplate(tenantId: string, id: string) {
  const target = await getTemplate(tenantId, id);
  if (!target.isActive) throw validation('An inactive template cannot be the default — make it active first');
  if (target.isDefault) return target;
  return db.transaction(async (tx) => {
    await tx.update(T).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(T.tenantId, tenantId), eq(T.isDefault, true)));
    const [row] = await tx.update(T).set({ isDefault: true, updatedAt: new Date() }).where(and(eq(T.tenantId, tenantId), eq(T.id, id))).returning();
    return shapeTemplate(row);
  });
}

/** A copy with the same configuration, a new id, a free "… Copy" name, never the default. */
export async function duplicateTemplate(tenantId: string, id: string) {
  const source = await getTemplate(tenantId, id);
  const names = new Set((await db.select({ n: T.templateName }).from(T).where(eq(T.tenantId, tenantId))).map((r) => r.n.toLowerCase()));
  const stem = source.templateName.slice(0, INVOICE_TEMPLATE_LIMITS.templateName - 8);
  let name = `${stem} Copy`;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${stem} Copy ${i}`;
  const [row] = await db
    .insert(T)
    .values({ tenantId, templateName: name, description: source.description, supportedMode: source.supportedMode, layoutPreset: source.layoutPreset, config: source.config, isActive: true, isDefault: false })
    .returning();
  return { source, template: shapeTemplate(row) };
}

export async function deleteTemplate(tenantId: string, id: string) {
  const existing = await getTemplate(tenantId, id);
  const refuse = () => validation('The default template cannot be deleted — make another template the default first');
  if (existing.isDefault) throw refuse();
  // `is_default = false` in the DELETE itself: a set-default that commits between the read above
  // and this statement must not have its new default removed.
  const gone = await db.delete(T).where(and(eq(T.tenantId, tenantId), eq(T.id, id), eq(T.isDefault, false))).returning({ id: T.id });
  if (!gone.length) throw refuse();
  return existing;
}

/** Active templates for the invoice preview's template picker — picker fields only. */
export async function templateLookup(tenantId: string) {
  await ensureStarterTemplates(tenantId);
  return db
    .select({ id: T.id, templateName: T.templateName, supportedMode: T.supportedMode, layoutPreset: T.layoutPreset, isDefault: T.isDefault })
    .from(T)
    .where(and(eq(T.tenantId, tenantId), eq(T.isActive, true)))
    .orderBy(desc(T.isDefault), asc(sql`lower(${T.templateName})`));
}

/**
 * The template a bill renders with.
 *   - `templateId` given: it must be this tenant's, active, and fit the bill's tax mode — else refused.
 *   - otherwise `pickInvoiceTemplate`: the default when it fits, else the first compatible
 *     active one (BOTH first), else the built-in Classic, so a bill can always be rendered.
 */
export async function resolveInvoiceTemplate(tenantId: string, taxMode: InvoiceTaxMode, templateId?: string): Promise<InvoiceTemplateSource> {
  if (templateId) {
    const t = await getTemplate(tenantId, templateId);
    if (!t.isActive) throw validation(`The template "${t.templateName}" is inactive`);
    if (!isTemplateCompatible(t.supportedMode, taxMode)) throw validation(`The template "${t.templateName}" cannot print a ${INVOICE_TAX_MODE_LABELS[taxMode]} bill`);
    return t;
  }
  const all = await listTemplates(tenantId);
  const picked = pickInvoiceTemplate(all, taxMode);
  if (picked) return picked;
  return { id: null, ...BUILT_IN_INVOICE_TEMPLATE() };
}
