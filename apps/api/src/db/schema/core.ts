import { pgTable, uuid, text, boolean, timestamp, integer, jsonb, uniqueIndex, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Shared column helpers — reuse in your own schema files.
// ---------------------------------------------------------------------------
export const ts = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};
export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
export const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

/** A tenant = one customer organisation using the app (multi-tenant by row). */
export const tenants = pgTable('tenants', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  isActive: boolean('is_active').notNull().default(true),
  ...ts,
});

/** Roles hold the permission grants. `key` is set for seeded system roles. */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    tenantId: tenantRef(),
    key: text('key'), // super_admin | admin | manager | user | null (custom)
    name: text('name').notNull(),
    description: text('description'),
    permissions: jsonb('permissions').$type<Record<string, string[]>>().notNull().default({}),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [uniqueIndex('roles_tenant_name_idx').on(t.tenantId, t.name)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: tenantRef(),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull().default(''),
    email: text('email').notNull(),
    username: text('username'),
    mobile: text('mobile'),
    passwordHash: text('password_hash').notNull(),
    avatarUrl: text('avatar_url'),
    /**
     * Retired: extra grants on top of the role. Still merged for rows that already carry them,
     * but no longer settable through the API or the UI — see docs/ARCHITECTURE.md.
     */
    permissionOverrides: jsonb('permission_overrides').$type<Record<string, string[]>>().notNull().default({}),
    companyIds: jsonb('company_ids').$type<string[]>().notNull().default([]),
    branchIds: jsonb('branch_ids').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    ...ts,
  },
  (t) => [uniqueIndex('users_tenant_email_idx').on(t.tenantId, t.email), index('users_role_idx').on(t.roleId)],
);

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Legal entities inside a tenant (a tenant may run several companies). */
export const companies = pgTable('companies', {
  id: id(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  isDefault: boolean('is_default').notNull().default(false),
  countryCode: text('country_code').notNull().default('IN'),
  taxId: text('tax_id'),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  pincode: text('pincode'),
  currency: text('currency').notNull().default('INR'),
  timeZone: text('time_zone').notNull().default('Asia/Kolkata'),
  /** Retired: no longer written or read. The display date format is `app_settings.dateFormat`. */
  dateFormat: text('date_format').notNull().default('dd-MM-yyyy'),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(4),
  /** Retired, always NULL: the logo lives in `company_logos` (see docs/SETTINGS.md). */
  logoUrl: text('logo_url'),
  isActive: boolean('is_active').notNull().default(true),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...ts,
}, (t) => [
  // The target of tenant-safe composite foreign keys (company_logos -> companies).
  unique('companies_id_tenant_uk').on(t.id, t.tenantId),
]);

export const branches = pgTable('branches', {
  id: id(),
  tenantId: tenantRef(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  address: text('address'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...ts,
});

/** Free-form tenant settings (key/value JSON). See services/settings.ts for defaults. */
export const appSettings = pgTable('app_settings', {
  id: id(),
  tenantId: tenantRef().unique(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  ...ts,
});

export const customFields = pgTable(
  'custom_fields',
  {
    id: id(),
    tenantId: tenantRef(),
    fieldName: text('field_name').notNull(),
    fieldLabel: text('field_label').notNull(),
    fieldType: text('field_type').notNull(),
    moduleNames: jsonb('module_names').$type<string[]>().notNull().default([]),
    fieldConfig: jsonb('field_config').$type<Record<string, unknown>>().notNull().default({}),
    isRequired: boolean('is_required').notNull().default(false),
    isReadOnly: boolean('is_read_only').notNull().default(false),
    tooltip: text('tooltip'),
    showTooltip: boolean('show_tooltip').notNull().default(false),
    defaultValue: text('default_value'),
    displaySection: text('display_section'),
    displayOrder: integer('display_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...ts,
  },
  (t) => [uniqueIndex('custom_fields_tenant_name_idx').on(t.tenantId, t.fieldName)],
);

/** Per-user list preferences (column layout + saved filter groups) keyed by module name. */
export const listPreferences = pgTable(
  'list_preferences',
  {
    id: id(),
    tenantId: tenantRef(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    moduleName: text('module_name').notNull(),
    columns: jsonb('columns').$type<{ key: string; visible: boolean }[]>().notNull().default([]),
    filterGroups: jsonb('filter_groups').notNull().default([]),
    ...ts,
  },
  (t) => [uniqueIndex('list_pref_idx').on(t.userId, t.moduleName)],
);

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: id(),
    tenantId: tenantRef(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(), // created | updated | deleted | login | ...
    description: text('description'),
    meta: jsonb('meta').notNull().default({}),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('activity_entity_idx').on(t.tenantId, t.entityType, t.entityId), index('activity_created_idx').on(t.tenantId, t.createdAt)],
);
