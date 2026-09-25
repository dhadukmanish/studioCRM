import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { companySchema, branchSchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { notFound, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { logActivity } from '../services/activity';
import { deleteCompanyLogo, getCompanyLogo, LOGO_MAX_BYTES, saveCompanyLogo } from '../services/company';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id is a missing company, not a database error. */
const companyIdParam = (req: { params: unknown }) => {
  const { id } = req.params as { id: string };
  if (!UUID.test(id)) throw notFound('Company');
  return id;
};

export async function orgRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.companies, base: '/api/admin/companies', permission: 'admin_companies', schema: companySchema, label: 'Company',
    searchColumns: [schema.companies.name, schema.companies.legalName, schema.companies.taxId], defaultSort: schema.companies.name,
    // The logo's version rides along on the list so the edit form can show the current logo;
    // the image bytes never do.
    join: { table: schema.companyLogos, on: and(eq(schema.companyLogos.companyId, schema.companies.id), eq(schema.companyLogos.tenantId, schema.companies.tenantId))!, columns: { logoUpdatedAt: schema.companyLogos.updatedAt } },
    toRow: (b) => ({ ...b, email: b.email || null }),
    afterCreate: async (row) => {
      // first company becomes default and gets a default branch
      const others = await db.select({ id: schema.companies.id }).from(schema.companies).where(and(eq(schema.companies.tenantId, row.tenantId), eq(schema.companies.isDefault, true)));
      if (!others.length) await db.update(schema.companies).set({ isDefault: true }).where(eq(schema.companies.id, row.id));
      await db.insert(schema.branches).values({ tenantId: row.tenantId, companyId: row.id, name: 'Head Office', isDefault: true });
    },
    beforeDelete: async (row) => { if (row.isDefault) throw validation('The default company cannot be deleted'); },
  });

  /**
   * Company logo. Reading it only needs a session — every screen's sidebar shows the default
   * company's logo — but it is always looked up inside the caller's own tenant, so another
   * tenant's company id is simply "not found". Changing it is an edit of the company.
   * The URL carries `?v=<version>`, which changes on every upload, so the image may be cached.
   */
  app.get('/api/admin/companies/:id/logo', { preHandler: app.authenticate }, async (req, reply) => {
    const logo = await getCompanyLogo(req.user.tenantId, companyIdParam(req));
    return reply.header('content-type', logo.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=31536000, immutable').send(logo.data);
  });
  app.put('/api/admin/companies/:id/logo', { preHandler: app.requirePermission('admin_companies', 'update') }, async (req) => {
    const id = companyIdParam(req);
    if (!req.isMultipart()) throw validation('Upload the logo as a multipart file');
    // Read one byte past the limit: the multipart reader TRUNCATES an oversized file rather than
    // always throwing, so a file cut to exactly the limit would otherwise pass as a valid one.
    const file = await req.file({ limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } });
    if (!file) throw validation('Choose a logo file to upload');
    let data: Buffer;
    try {
      data = await file.toBuffer();
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw validation('The logo must be 1 MB or smaller');
      throw e;
    }
    if (file.file.truncated || data.length > LOGO_MAX_BYTES) throw validation('The logo must be 1 MB or smaller');
    const saved = await saveCompanyLogo(req.user.tenantId, id, data);
    await logActivity(req, 'company', id, 'updated', `Company logo updated: ${saved.company.name}`, { contentType: saved.logo.contentType, bytes: data.length });
    return ok(saved.logo, 'Logo saved');
  });
  app.delete('/api/admin/companies/:id/logo', { preHandler: app.requirePermission('admin_companies', 'update') }, async (req) => {
    const id = companyIdParam(req);
    const company = await deleteCompanyLogo(req.user.tenantId, id);
    await logActivity(req, 'company', id, 'updated', `Company logo removed: ${company.name}`);
    return ok(null, 'Logo removed');
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
