import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { todayInTimeZone, type PlanKind, type SubscriptionAccess, type SubscriptionPaymentMode } from '@erp/shared';
import type { output, ZodTypeAny } from 'zod';
import { ApiError, qs } from '@/lib/api';
import { platformApi } from '@/lib/platformApi';
import { toast } from '@/lib/toast';
import type { PlatformAdmin } from '@/store/platformAuth';

/*
 * Platform panel data. Every query key starts with 'platform', so the panel's cache can never
 * collide with a studio cache in the same QueryClient and is dropped as one on sign-out.
 * Shapes mirror apps/api/src/routes/platform.ts + services/subscriptions.ts.
 */

export interface Plan {
  id: string;
  name: string;
  kind: PlanKind;
  /** Null for a Day-wise plan — the days are chosen when granting. */
  durationDays: number | null;
  /** Per-day price for a Day-wise plan. */
  price: string;
  isActive: boolean;
  sortOrder: number;
  /** Periods ever granted on it; only an unused plan can be deleted. */
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Studio {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  userCount: number;
  owner: { id: string; name: string; email: string; mobile: string | null; lastLoginAt: string | null } | null;
  access: SubscriptionAccess;
}

export interface Period {
  id: string;
  planId: string;
  planName: string;
  kind: PlanKind;
  days: number;
  startsOn: string;
  endsOn: string;
  amount: string;
  paymentMode: SubscriptionPaymentMode | null;
  paymentRef: string | null;
  paidOn: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export type StudioDetail = Studio & { periods: Period[] };

export interface PlatformSummary {
  today: string;
  total: number;
  trial: number;
  active: number;
  grace: number;
  expired: number;
  suspended: number;
  unmanaged: number;
  expiringSoon: number;
  revenueThisMonth: string;
}

export const PAYMENT_MODE_LABELS: Record<SubscriptionPaymentMode, string> = { CASH: 'Cash', UPI: 'UPI', BANK: 'Bank transfer', CHEQUE: 'Cheque', OTHER: 'Other' };

export const usePlatformMe = (enabled: boolean) => useQuery({ queryKey: ['platform', 'me'], queryFn: () => platformApi.get<PlatformAdmin>('/api/platform/auth/me'), enabled, staleTime: 5 * 60_000 });
export const usePlatformSummary = () => useQuery({ queryKey: ['platform', 'summary'], queryFn: () => platformApi.get<PlatformSummary>('/api/platform/summary'), staleTime: 30_000 });
export const usePlans = () => useQuery({ queryKey: ['platform', 'plans'], queryFn: () => platformApi.get<Plan[]>('/api/platform/plans'), staleTime: 60_000 });
export const useStudios = (search: string) =>
  useQuery({ queryKey: ['platform', 'studios', search], queryFn: () => platformApi.get<Studio[]>(`/api/platform/studios${qs({ search })}`), placeholderData: (prev) => prev });
export const useStudio = (id: string) => useQuery({ queryKey: ['platform', 'studio', id], queryFn: () => platformApi.get<StudioDetail>(`/api/platform/studios/${id}`) });

/**
 * "Today" for the grant preview: the server's business date when the summary is loaded, else the
 * studio timezone's date. Display only — the server dates every period itself.
 */
export function usePlatformToday(): string {
  return usePlatformSummary().data?.today ?? todayInTimeZone('Asia/Kolkata');
}

/**
 * A platform write: toasts the server's message, refreshes every platform query (a grant changes
 * the studio, the list and the summary together), and hands back `data`.
 */
export function usePlatformSave<TResult = unknown>(opts: { onSuccess?: (r: TResult) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method, url, body }: { method: 'post' | 'put' | 'delete'; url: string; body?: unknown }) => platformApi.raw<{ message: string; data: TResult }>(method.toUpperCase(), url, body),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['platform'] });
      toast.success(r?.message ?? 'Saved');
      opts.onSuccess?.(r?.data as TResult);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong'),
  });
}

type SetError = (name: never, err: { message: string }) => void;

/**
 * Put server validation onto form fields. Two shapes come back: zod issues
 * (`[{ path: ['subscription', 'days'], message }]`) and a service rule's `{ field: message }` map
 * (the grant rules: days, paymentMode). The grant fields live under `subscription.` in both
 * dialogs, so each shape takes its own prefix: a grant's issues and map both need it; a new
 * studio's issues already carry it and only the map needs it.
 */
export function applyPlatformErrors(e: unknown, setError: SetError, prefix: { issues?: string; map?: string } = {}) {
  if (!(e instanceof ApiError) || !e.details) return;
  const put = (path: string, message: string) => (setError as (n: string, err: { message: string }) => void)(path, { message });
  if (Array.isArray(e.details)) {
    for (const d of e.details as { path?: (string | number)[] | string; message: string }[]) if (d.path?.length) put((prefix.issues ?? '') + (Array.isArray(d.path) ? d.path.join('.') : d.path), d.message);
  } else if (typeof e.details === 'object') {
    for (const [k, v] of Object.entries(e.details as Record<string, unknown>)) if (typeof v === 'string') put((prefix.map ?? '') + k, v);
  }
}

/** Client-side check with a shared zod schema; issues go onto the form, `null` means invalid. */
export function checkWith<S extends ZodTypeAny>(schema: S, value: unknown, setError: SetError, prefix = ''): output<S> | null {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  for (const i of r.error.issues) (setError as (n: string, err: { message: string }) => void)(prefix + i.path.join('.'), { message: i.message });
  return null;
}
