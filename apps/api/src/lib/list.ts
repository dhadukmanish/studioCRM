import type { ListQuery } from '@erp/shared';

export function parseListQuery(q: Record<string, unknown>): Required<Pick<ListQuery, 'page' | 'limit' | 'sortOrder'>> & ListQuery {
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const limit = Math.min(500, Math.max(1, Number(q.limit ?? q.pageSize ?? 20) || 20));
  return {
    page,
    limit,
    sortBy: typeof q.sortBy === 'string' ? q.sortBy : undefined,
    sortOrder: q.sortOrder === 'asc' ? 'asc' : 'desc',
    search: typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined,
    firmId: typeof q.firmId === 'string' && q.firmId ? q.firmId : undefined,
    branchId: typeof q.branchId === 'string' && q.branchId ? q.branchId : undefined,
  };
}
