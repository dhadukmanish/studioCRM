import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, sql, schema } from './client';
import { seedTenantDefaults } from '../services/tenant-setup';

const TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? 'demo';
const TENANT_NAME = process.env.SEED_TENANT_NAME ?? 'Demo Company';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@1234';

async function main() {
  const existing = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, TENANT_SLUG)).limit(1);
  if (existing.length) {
    console.log(`Tenant "${TENANT_SLUG}" already exists — nothing to do.`);
    return;
  }
  const [tenant] = await db.insert(schema.tenants).values({ name: TENANT_NAME, slug: TENANT_SLUG }).returning();
  const { roles, company, branch } = await seedTenantDefaults(db, tenant.id, { companyName: TENANT_NAME });
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await db.insert(schema.users).values({ tenantId: tenant.id, roleId: roles.super_admin.id, firstName: 'Super', lastName: 'Admin', email: ADMIN_EMAIL, username: 'admin', mobile: '9999999999', passwordHash, companyIds: [company.id], branchIds: [branch.id] });
  // a second, restricted user to demo RBAC
  await db.insert(schema.users).values({ tenantId: tenant.id, roleId: roles.user.id, firstName: 'Read', lastName: 'Only', email: 'viewer@example.com', username: 'viewer', passwordHash, companyIds: [company.id], branchIds: [branch.id] });
  console.log(`Seeded tenant "${tenant.slug}"`);
  console.log(`Super admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`Read-only user: viewer@example.com / ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => sql.end());
