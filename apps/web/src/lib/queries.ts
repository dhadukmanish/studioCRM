import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { ListState } from '@/components/data/DataTable';

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }

export function listParams(s: ListState, extra: Record<string, unknown> = {}) {
  return qs({ page: s.page, limit: s.limit, search: s.search, sortBy: s.sortBy, sortOrder: s.sortOrder, filters: s.filters?.length ? JSON.stringify(s.filters) : undefined, ...extra });
}

/** Generic paginated list */
export function useList<T>(key: string, url: string, state: ListState, extra: Record<string, unknown> = {}, enabled = true) {
  return useQuery({
    queryKey: [key, state, extra],
    queryFn: () => api.get<Page<T>>(`${url}${listParams(state, extra)}`),
    placeholderData: (prev) => prev,
    enabled,
  });
}

/** Lookups (cached longer) */
export const useCompanies = () => useQuery({ queryKey: ['lookup', 'companies'], queryFn: () => api.get<{ id: string; name: string; isDefault: boolean; currency: string }[]>('/api/common/lookups/companies'), staleTime: 60_000 });
export const useBranches = (companyId?: string) => useQuery({ queryKey: ['lookup', 'branches', companyId], queryFn: () => api.get<{ id: string; companyId: string; name: string; isDefault: boolean }[]>(`/api/common/lookups/branches${qs({ companyId })}`), staleTime: 60_000 });
export const useRoles = () => useQuery({ queryKey: ['lookup', 'roles'], queryFn: () => api.get<{ id: string; name: string; key: string | null; isSystem: boolean }[]>('/api/common/lookups/roles'), staleTime: 60_000 });
export const useUsersLookup = () => useQuery({ queryKey: ['lookup', 'users'], queryFn: () => api.get<{ id: string; name: string; email: string }[]>('/api/common/lookups/users'), staleTime: 60_000 });
/** Active Item Master rows, for the Sub Item parent picker and the list's item filter. */
export const useItemsLookup = () => useQuery({ queryKey: ['lookup', 'items'], queryFn: () => api.get<{ id: string; itemName: string }[]>('/api/common/lookups/items'), staleTime: 60_000 });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, any>>('/api/settings'), staleTime: 60_000 });
export const useCustomFields = (moduleName: string) => useQuery({ queryKey: ['custom-fields', moduleName], queryFn: () => api.get<{ fields: any[] }>(`/api/custom-fields/${moduleName}`), staleTime: 60_000, select: (d) => d.fields });

/** Mutation helper with toast + invalidation */
export function useSave<TBody = any, TResult = any>(opts: { invalidate: string[]; onSuccess?: (r: TResult) => void; successMessage?: string }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ method, url, body }: { method: 'post' | 'put' | 'delete' | 'patch'; url: string; body?: TBody }) => {
      const r = await api.raw<{ message: string; data: TResult }>(method.toUpperCase(), url, body);
      return r;
    },
    onSuccess: (r) => {
      opts.invalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(opts.successMessage ?? r?.message ?? 'Saved');
      opts.onSuccess?.(r?.data);
    },
    onError: (e: any) => {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong';
      toast.error(msg);
    },
  });
}

/** Map zod/API validation details into a form's setError */
export function applyApiErrors(e: unknown, setError?: (name: any, err: { message: string }) => void) {
  if (e instanceof ApiError && Array.isArray(e.details) && setError) {
    for (const d of e.details) if (d.path?.length) setError(Array.isArray(d.path) ? d.path.join('.') : d.path, { message: d.message });
  }
}
