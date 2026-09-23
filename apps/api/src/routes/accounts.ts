import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import { accountSchema, HEAD_GROUPS } from '@erp/shared';
import { db, schema } from '../db/client';
import { parse } from '../lib/validate';
import { notFound } from '../lib/errors';
import { ok } from '../lib/respond';
import { parseListQuery } from '../lib/list';
import { filterWhere, sortBy, tableColumns } from '../lib/filters';
import { logActivity } from '../services/activity';
import { getAccount, saveAccount, shapeAccount } from '../services/accounts';

/**
 * Account Master — HEAD GROUP -> ACCOUNT GROUP -> ACCOUNT.
 *
 * Hand-written rather than built on `crudRoutes` for one reason: an account and its
 * group-specific detail block are two tables and must be written atomically, which the CRUD
 * factory's create/update hooks run outside of. Everything else — the list query helpers, the
 * permission check, the tenant predicate, the response envelope and the audit entry — is the
 * same machinery the factory uses, so the HTTP surface matches the other masters exactly.
 */
const PERMISSION = 'masters_accounts';
const BASE = '/api/masters/accounts';
const LABEL = 'Account';

/** The list's sortable/filterable columns: the account's own, plus the two joined from its group. */
const listColumns = () => ({
  ...tableColumns(schema.accounts),
  groupName: schema.accountGroups.groupName,
  headGroup: schema.accountGroups.headGroup,
});

/** Ids arrive from the client as text; a non-uuid must narrow the list to nothing, not error. */
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function accountRoutes(app: FastifyInstance) {
  /**
   * List. Joins `account_groups` once so every row carries its group's name and head group
   * without a query per row, and without a second copy of them in the accounts table.
   */
  app.get(BASE, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const query = req.query as Record<string, unknown>;
    const cols = listColumns();
    const where = and(
      eq(schema.accounts.tenantId, req.user.tenantId),
      q.search ? or(ilike(schema.accounts.accountName, `%${q.search}%`), ilike(schema.accountGroups.groupName, `%${q.search}%`)) : undefined,
      filterWhere(query.filters, cols),
      isUuid(query.accountGroupId) ? eq(schema.accounts.accountGroupId, query.accountGroupId) : undefined,
      typeof query.headGroup === 'string' && (HEAD_GROUPS as readonly string[]).includes(query.headGroup) ? eq(schema.accountGroups.headGroup, query.headGroup) : undefined,
      query.isActive === 'true' ? eq(schema.accounts.isActive, true) : query.isActive === 'false' ? eq(schema.accounts.isActive, false) : undefined,
    );
    const from = (fields: Record<string, unknown>) =>
      (db.select(fields as never).from(schema.accounts) as any).innerJoin(schema.accountGroups, eq(schema.accountGroups.id, schema.accounts.accountGroupId));

    const [{ total }] = await from({ total: count() }).where(where);
    const rows = await from({ ...tableColumns(schema.accounts), groupName: schema.accountGroups.groupName, headGroup: schema.accountGroups.headGroup })
      .where(where)
      .orderBy(sortBy(q.sortBy, q.sortOrder, cols, schema.accounts.updatedAt))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
    return ok({ rows: rows.map(shapeAccount), total: Number(total), page: q.page, pageSize: q.limit }, `${LABEL}s retrieved successfully`);
  });

  /** One account with the detail block its group drives — what the edit form loads. */
  app.get(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION) }, async (req) => {
    const { id } = req.params as { id: string };
    return ok(await getAccount(req.user.tenantId, id));
  });

  app.post(BASE, { preHandler: app.requirePermission(PERMISSION, 'create') }, async (req) => {
    const body = parse(accountSchema, req.body);
    const { changed, previous, ...created } = await saveAccount(req.user.tenantId, body, (req.body as { detail?: unknown })?.detail);
    await logActivity(req, 'account', created.id, 'created', `${LABEL} "${created.accountName}" created`);
    return ok(created, `${LABEL} created successfully`);
  });

  app.put(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'update') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(accountSchema.partial(), req.body);
    const { changed, previous, ...updated } = await saveAccount(req.user.tenantId, body, (req.body as { detail?: unknown })?.detail, id);
    await logActivity(req, 'account', updated.id, 'updated', `${LABEL} "${updated.accountName}" updated`, { changed });
    return ok(updated, `${LABEL} updated successfully`);
  });

  /** Detail rows go with the account — their foreign key cascades. */
  app.delete(`${BASE}/:id`, { preHandler: app.requirePermission(PERMISSION, 'delete') }, async (req) => {
    const { id } = req.params as { id: string };
    const [existing] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.tenantId, req.user.tenantId)));
    if (!existing) throw notFound(LABEL);
    await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
    await logActivity(req, 'account', id, 'deleted', `${LABEL} "${existing.accountName}" deleted`);
    return ok(null, `${LABEL} deleted successfully`);
  });

  /**
   * Lookup for pickers — Billing, Payment and Voucher will each need one. Only the fields a
   * picker needs: bank account numbers, salaries, PAN and GST are account detail and must not
   * leak through a list every authenticated user can read.
   *
   * Active accounts only: a deactivated account is not offered for a new transaction.
   */
  app.get('/api/common/lookups/accounts', { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({
        id: schema.accounts.id,
        accountName: schema.accounts.accountName,
        accountGroupId: schema.accounts.accountGroupId,
        groupName: schema.accountGroups.groupName,
        headGroup: schema.accountGroups.headGroup,
      })
      .from(schema.accounts)
      .innerJoin(schema.accountGroups, eq(schema.accountGroups.id, schema.accounts.accountGroupId))
      .where(and(eq(schema.accounts.tenantId, req.user.tenantId), eq(schema.accounts.isActive, true)))
      .orderBy(asc(schema.accounts.accountName));
    return ok(rows);
  });
}
