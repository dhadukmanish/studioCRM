import type { Db } from '../db/client';
import { schema } from '../db/client';
import { SYSTEM_ROLES, defaultRoleGrants, type SystemRoleKey } from '@erp/shared';
import { DEFAULT_SETTINGS } from './settings';

/**
 * Bootstraps a brand-new tenant: system roles, default company + branch, settings.
 * Called by the seed script and by any future self-signup flow.
 */
export async function seedTenantDefaults(db: Db, tenantId: string, opts: { companyName: string; currency?: string; countryCode?: string }) {
  const roleRows = await db
    .insert(schema.roles)
    .values((Object.keys(SYSTEM_ROLES) as SystemRoleKey[]).map((key) => ({ tenantId, key, name: SYSTEM_ROLES[key].name, description: SYSTEM_ROLES[key].description, permissions: defaultRoleGrants(key), isSystem: true })))
    .returning();
  const roles = Object.fromEntries(roleRows.map((r) => [r.key as SystemRoleKey, r])) as Record<SystemRoleKey, typeof roleRows[number]>;
  const [company] = await db.insert(schema.companies).values({ tenantId, name: opts.companyName, isDefault: true, currency: opts.currency ?? 'INR', countryCode: opts.countryCode ?? 'IN' }).returning();
  const [branch] = await db.insert(schema.branches).values({ tenantId, companyId: company.id, name: 'Head Office', isDefault: true }).returning();
  await db.insert(schema.appSettings).values({ tenantId, settings: { ...DEFAULT_SETTINGS } });
  return { roles, company, branch };
}
