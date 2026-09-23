import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { accountGroupSchema, HEAD_GROUPS, type HeadGroup } from '@erp/shared';
import { crudRoutes } from '../lib/crud';
import { validation } from '../lib/errors';
import { ok } from '../lib/respond';

/**
 * Account Group Master — how a studio classifies its accounts. List/search/filter/sort/
 * paginate, create, update and delete come from the CRUD factory, which also enforces the
 * permission and the tenant predicate on every query.
 *
 * Classification only: this module posts nothing and balances nothing.
 */
export async function accountGroupRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.accountGroups,
    base: '/api/masters/account-groups',
    permission: 'masters_account_groups',
    schema: accountGroupSchema,
    label: 'Account Group',
    labelField: 'groupName',
    searchColumns: [schema.accountGroups.groupName],
    defaultSort: schema.accountGroups.updatedAt,
    filter: (_req, q) => [
      q.headGroup && (HEAD_GROUPS as readonly string[]).includes(q.headGroup) ? eq(schema.accountGroups.headGroup, q.headGroup) : undefined,
      q.isActive === 'true' ? eq(schema.accountGroups.isActive, true) : q.isActive === 'false' ? eq(schema.accountGroups.isActive, false) : undefined,
    ],
    /**
     * Friendly duplicate message. `account_groups_tenant_name_lower_idx` is the real guard — a
     * race that slips past this check still fails at the database and surfaces as a 409.
     */
    beforeSave: async (body, req, existing) => {
      if (!body.groupName) return;
      const [clash] = await db
        .select({ id: schema.accountGroups.id })
        .from(schema.accountGroups)
        .where(
          and(
            eq(schema.accountGroups.tenantId, req.user.tenantId),
            sql`lower(${schema.accountGroups.groupName}) = lower(${body.groupName})`,
            existing ? ne(schema.accountGroups.id, existing.id) : undefined,
          ),
        )
        .limit(1);
      if (clash) throw validation(`An account group named "${body.groupName}" already exists`, [{ path: ['groupName'], message: 'This account group name is already used' }]);
    },
  });

  /**
   * Lookup for pickers — Account Master's group selector next. Active groups only; the head
   * group rides along because a picker wants to show what a group is classified as.
   */
  app.get('/api/common/lookups/account-groups', { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({ id: schema.accountGroups.id, groupName: schema.accountGroups.groupName, headGroup: schema.accountGroups.headGroup })
      .from(schema.accountGroups)
      .where(and(eq(schema.accountGroups.tenantId, req.user.tenantId), eq(schema.accountGroups.isActive, true)))
      .orderBy(asc(schema.accountGroups.groupName));
    return ok(rows as { id: string; groupName: string; headGroup: HeadGroup }[]);
  });
}
