import { pgTable, uuid, text, boolean, jsonb, integer } from 'drizzle-orm/pg-core';
import { id, ts, tenantRef } from './core';

/**
 * SAMPLE MODULE — a simple hierarchical master.
 * Copy this file for your own entities, add it to schema/index.ts, then
 * `pnpm db:generate && pnpm db:migrate`.
 */
export const categories = pgTable('categories', {
  id: id(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  code: text('code'),
  parentId: uuid('parent_id'),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  ...ts,
});
