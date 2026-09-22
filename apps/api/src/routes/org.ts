import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { companySchema, branchSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';

export async function orgRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.companies, base: '/api/admin/companies', permission: 'admin_companies', schema: companySchema, label: 'Company',
    searchColumns: [schema.companies.name, schema.companies.legalName, schema.companies.taxId], defaultSort: schema.companies.name,
    toRow: (b) => ({ ...b, email: b.email || null }),
    afterCreate: async (row) => {
      // first company becomes default and gets a default branch
      const others = await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.tenantId, row.tenantId), eq(schema.companies.isDefault, true)));
      if (!others.length) await db.update(schema.companies).set({ isDefault: true }).where(eq(schema.companies.id, row.id));
      await db.insert(schema.branches).values({ tenantId: row.tenantId, companyId: row.id, name: 'Head Office', isDefault: true });
    },
    beforeDelete: async (row) => { if (row.isDefault) throw validation('The default company cannot be deleted'); },
  });

  crudRoutes(app, {
    table: schema.branches, base: '/api/admin/branches', permission: 'admin_branches', schema: branchSchema, label: 'Branch',
    searchColumns: [schema.branches.name, schema.branches.code], defaultSort: schema.branches.name,
    filter: (_r, q) => [q.companyId ? eq(schema.branches.companyId, q.companyId) : undefined],
    beforeDelete: async (row) => { if (row.isDefault) throw validation('The default branch cannot be deleted'); },
  });

  /** Lookups for pickers — only what the current user can access */
  app.get('/api/common/lookups/companies', { preHandler: app.authenticate }, async (req) => {
    const rows = await db.select({ id: schema.companies.id, name: schema.companies.name, isDefault: schema.companies.isDefault, currency: schema.companies.currency }).from(schema.companies).where(and(eq(schema.companies.tenantId, req.user.tenantId), eq(schema.companies.isActive, true))).orderBy(desc(schema.companies.isDefault), asc(schema.companies.name));
    return ok(req.user.isSuperAdmin || !req.user.companyIds.length ? rows : rows.filter((c) => req.user.companyIds.includes(c.id)));
  });
  app.get('/api/common/lookups/branches', { preHandler: app.authenticate }, async (req) => {
    const { companyId } = req.query as { companyId?: string };
    const rows = await db.select({ id: schema.branches.id, companyId: schema.branches.companyId, name: schema.branches.name, isDefault: schema.branches.isDefault }).from(schema.branches).where(and(eq(schema.branches.tenantId, req.user.tenantId), eq(schema.branches.isActive, true), companyId ? eq(schema.branches.companyId, companyId) : undefined)).orderBy(desc(schema.branches.isDefault), asc(schema.branches.name));
    return ok(rows);
  });
}
