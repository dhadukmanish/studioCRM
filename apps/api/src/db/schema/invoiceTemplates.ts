import { pgTable, text, boolean, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { InvoiceTemplateConfig } from '@erp/shared';
import { id, ts, tenantRef } from './core';

/**
 * Invoice Template Master — how a bill is PRESENTED (docs/INVOICE_TEMPLATES.md). A template
 * never stores money and nothing references it: a bill does not remember which template printed
 * it, so deleting a template can never touch a bill.
 *
 * `config` is the controlled presentation JSON, validated by `invoiceTemplateConfigSchema` on
 * every write — never HTML, CSS or script.
 */
export const invoiceTemplates = pgTable(
  'invoice_templates',
  {
    id: id(),
    tenantId: tenantRef(),
    templateName: text('template_name').notNull(),
    description: text('description'),
    /** BOTH | WITH_GST | WITHOUT_GST — which bills this template may render. */
    supportedMode: text('supported_mode').notNull().default('BOTH'),
    /** CLASSIC | COMPACT | DETAILED — the fixed visual style. */
    layoutPreset: text('layout_preset').notNull().default('CLASSIC'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    config: jsonb('config').$type<InvoiceTemplateConfig>().notNull(),
    ...ts,
  },
  (t) => [
    uniqueIndex('invoice_templates_tenant_name_lower_idx').on(t.tenantId, sql`lower(${t.templateName})`),
    // At most ONE default per tenant, enforced by the database: moving the default is two
    // updates in one transaction, and a race between two of them fails here instead of leaving
    // two defaults behind.
    uniqueIndex('invoice_templates_one_default_idx').on(t.tenantId).where(sql`${t.isDefault}`),
    index('invoice_templates_tenant_updated_idx').on(t.tenantId, t.updatedAt),
    check('invoice_templates_supported_mode_check', sql`${t.supportedMode} in ('BOTH', 'WITH_GST', 'WITHOUT_GST')`),
    check('invoice_templates_layout_preset_check', sql`${t.layoutPreset} in ('CLASSIC', 'COMPACT', 'DETAILED')`),
    check('invoice_templates_name_not_blank_check', sql`length(btrim(${t.templateName})) > 0`),
    // The default is what a bill prints with when nobody chooses: it must be usable.
    check('invoice_templates_default_is_active_check', sql`not ${t.isDefault} or ${t.isActive}`),
  ],
);
