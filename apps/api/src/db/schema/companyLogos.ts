import { pgTable, uuid, text, integer, timestamp, customType, foreignKey, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenantRef, companies } from './core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * A company's logo, kept in the database rather than on disk: the host replaces the site folder
 * on every deploy, so a file written next to the app would not survive one. One row per company
 * (the company id is the key), deleted with the company.
 *
 * Kept out of `companies` on purpose, so listing or editing a company never drags the image
 * bytes along. `updated_at` is the version the browser caches against.
 */
export const companyLogos = pgTable(
  'company_logos',
  {
    companyId: uuid('company_id').primaryKey(),
    tenantId: tenantRef(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    data: bytea('data').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.companyId, t.tenantId], foreignColumns: [companies.id, companies.tenantId], name: 'company_logos_company_tenant_fk' }).onDelete('cascade'),
    check('company_logos_content_type_check', sql`${t.contentType} in ('image/png', 'image/jpeg', 'image/webp')`),
    check('company_logos_byte_size_check', sql`${t.byteSize} > 0 and ${t.byteSize} = octet_length(${t.data})`),
  ],
);

/**
 * A company's other print images — the authorised signature and an optional footer graphic
 * (Print & Invoice settings). Stored like the logo, in the database, for the same reason: the host
 * replaces the site folder on every deploy. One row per (company, kind), deleted with the company.
 */
export const companyPrintAssets = pgTable(
  'company_print_assets',
  {
    companyId: uuid('company_id').notNull(),
    tenantId: tenantRef(),
    /** SIGNATURE | FOOTER */
    kind: text('kind').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    data: bytea('data').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.kind], name: 'company_print_assets_pk' }),
    foreignKey({ columns: [t.companyId, t.tenantId], foreignColumns: [companies.id, companies.tenantId], name: 'company_print_assets_company_tenant_fk' }).onDelete('cascade'),
    check('company_print_assets_kind_check', sql`${t.kind} in ('SIGNATURE', 'FOOTER')`),
    check('company_print_assets_content_type_check', sql`${t.contentType} in ('image/png', 'image/jpeg', 'image/webp')`),
    check('company_print_assets_byte_size_check', sql`${t.byteSize} > 0 and ${t.byteSize} = octet_length(${t.data})`),
  ],
);
