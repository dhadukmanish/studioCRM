import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { HeadGroup } from '@erp/shared';
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
/**
 * Active Item Master rows, for the Sub Item parent picker, the list's item filter and the
 * billing grid. `gstRate` rides along because a bill line has to show the operator the tax the
 * chosen item carries — it is a DEFAULT for display only; the rate a bill stores is the one
 * the server snapshots off Item Master inside the bill's own transaction.
 */
export const useItemsLookup = () => useQuery({ queryKey: ['lookup', 'items'], queryFn: () => api.get<ItemLookup[]>('/api/common/lookups/items'), staleTime: 60_000 });
export interface ItemLookup { id: string; itemName: string; gstRate: number }

/** Active Book Master rows, for Billing's book (bill number series) picker. */
export const useBooksLookup = () => useQuery({ queryKey: ['lookup', 'books'], queryFn: () => api.get<BookLookup[]>('/api/common/lookups/books'), staleTime: 60_000 });
export interface BookLookup { id: string; bookNumber: string }

/**
 * Active products under one item. Disabled without an item: the endpoint answers `[]` for a
 * blank `itemId`, and a query that can only return nothing is not worth running. The rate and
 * the remark come with each row because they are exactly what picking a product fills in.
 */
export const useSubItemsLookup = (itemId?: string) =>
  useQuery({ queryKey: ['lookup', 'sub-items', itemId ?? ''], queryFn: () => api.get<SubItemLookup[]>(`/api/common/lookups/sub-items${qs({ itemId })}`), staleTime: 60_000, enabled: !!itemId });
export interface SubItemLookup { id: string; itemId: string; productName: string; rate: number; remark: string | null }

/**
 * Bookings for a customer's mobile, newest first — Billing's "is this walk-in already booked?"
 * lookup. Pass the digits you want matched; the caller decides when there are enough of them
 * and debounces, so this never fires per keystroke. A blank value disables the query, because
 * an empty mobile is not a request for every appointment in the tenant.
 */
export const useAppointmentsLookup = (mobile: string) =>
  useQuery({ queryKey: ['lookup', 'appointments', mobile], queryFn: () => api.get<AppointmentLookup[]>(`/api/common/lookups/appointments${qs({ mobile })}`), staleTime: 30_000, enabled: !!mobile });
export interface AppointmentLookup {
  id: string;
  appointmentNumber: number;
  appointmentDate: string;
  appointmentTime: string | null;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
}
/** Active Account Group rows, for the Account Master group picker and the list's group filter. */
export const useAccountGroupsLookup = () => useQuery({ queryKey: ['lookup', 'account-groups'], queryFn: () => api.get<{ id: string; groupName: string; headGroup: HeadGroup }[]>('/api/common/lookups/account-groups'), staleTime: 60_000 });
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
