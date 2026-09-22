import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, isNotNull, lt, lte, ne, notIlike, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { parseFilters, type ListFilter } from '@erp/shared';

export type ColumnMap = Record<string, PgColumn | SQL>;

/** All real columns of a drizzle table, keyed by their TS property name (e.g. companyName). */
export function tableColumns(table: any): ColumnMap {
  const out: ColumnMap = {};
  for (const [k, v] of Object.entries(table)) if (v && typeof v === 'object' && 'columnType' in (v as any)) out[k] = v as PgColumn;
  return out;
}

const isNumericCol = (c: any) => /numeric|integer|bigint|real|double|serial/i.test(c?.columnType ?? '');
const isDateCol = (c: any) => /date|timestamp/i.test(c?.columnType ?? '');
const isBoolCol = (c: any) => /boolean/i.test(c?.columnType ?? '');

function one(f: ListFilter, col: PgColumn | SQL): SQL | undefined {
  const c = col as any;
  const v = f.value;
  const str = v == null ? '' : String(v);
  if (f.op === 'is_empty') return or(isNull(c), sql`${c}::text = ''`);
  if (f.op === 'is_not_empty') return and(isNotNull(c), sql`${c}::text <> ''`);
  if (str === '' && !Array.isArray(v)) return undefined;
  const cast = (x: unknown) => (isBoolCol(c) ? String(x) === 'true' : isNumericCol(c) ? Number(x) : x);
  switch (f.op) {
    case 'contains': return ilike(sql`${c}::text`, `%${str}%`);
    case 'not_contains': return notIlike(sql`${c}::text`, `%${str}%`);
    case 'starts_with': return ilike(sql`${c}::text`, `${str}%`);
    case 'ends_with': return ilike(sql`${c}::text`, `%${str}`);
    case 'equals': return isDateCol(c) ? sql`${c}::date = ${str}::date` : isNumericCol(c) || isBoolCol(c) ? eq(c, cast(v)) : ilike(sql`${c}::text`, str);
    case 'not_equals': return isDateCol(c) ? sql`${c}::date <> ${str}::date` : isNumericCol(c) || isBoolCol(c) ? ne(c, cast(v)) : notIlike(sql`${c}::text`, str);
    case 'gt': return isDateCol(c) ? sql`${c}::date > ${str}::date` : gt(c, cast(v));
    case 'gte': return isDateCol(c) ? sql`${c}::date >= ${str}::date` : gte(c, cast(v));
    case 'lt': return isDateCol(c) ? sql`${c}::date < ${str}::date` : lt(c, cast(v));
    case 'lte': return isDateCol(c) ? sql`${c}::date <= ${str}::date` : lte(c, cast(v));
    case 'between': {
      const [a, b] = Array.isArray(v) ? v : String(v).split(',');
      if (a == null || b == null || a === '' || b === '') return undefined;
      return isDateCol(c) ? and(sql`${c}::date >= ${String(a)}::date`, sql`${c}::date <= ${String(b)}::date`) : and(gte(c, cast(a)), lte(c, cast(b)));
    }
    case 'in': {
      const list = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
      return list.length ? inArray(c, list.map(cast)) : undefined;
    }
    default: return undefined;
  }
}

/** Build a WHERE fragment from the request's `filters` query param, restricted to known columns. */
export function filterWhere(rawFilters: unknown, columns: ColumnMap): SQL | undefined {
  const parts = parseFilters(rawFilters).map((f) => (columns[f.field] ? one(f, columns[f.field]) : undefined)).filter(Boolean) as SQL[];
  return parts.length ? and(...parts) : undefined;
}

/** Resolve sort column from a query, restricted to known columns. */
export function sortBy(sort: string | undefined, order: 'asc' | 'desc', columns: ColumnMap, fallback: PgColumn | SQL) {
  const col = (sort && columns[sort]) || fallback;
  return order === 'asc' ? asc(col as any) : desc(col as any);
}
