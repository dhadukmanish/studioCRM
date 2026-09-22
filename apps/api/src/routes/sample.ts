import type { FastifyInstance } from 'fastify';
import { schema } from '../db/client';
import { categorySchema } from '@erp/shared';
import { crudRoutes } from '../lib/crud';

/**
 * SAMPLE MODULE — one call gives you list (search/filter/sort/paginate),
 * get, create, update, delete with permission checks and activity logging.
 */
export async function sampleRoutes(app: FastifyInstance) {
  crudRoutes(app, {
    table: schema.categories,
    base: '/api/sample/categories',
    permission: 'sample_categories',
    schema: categorySchema,
    label: 'Category',
    searchColumns: [schema.categories.name, schema.categories.code],
    defaultSort: schema.categories.name,
    toRow: (b) => ({ ...b, parentId: b.parentId || null }),
  });
}
