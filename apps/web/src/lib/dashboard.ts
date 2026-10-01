import { useQuery } from '@tanstack/react-query';
import type { DashboardPeriod, DashboardSummary } from '@erp/shared';
import { api, qs } from '@/lib/api';

/**
 * The Dashboard's figures (`apps/api/src/routes/dashboard.ts`, docs/DASHBOARD.md). The server
 * resolves the period from the business date and returns only the sections this user may see.
 * Stale immediately, so returning to the dashboard always shows current figures.
 */
export const useDashboard = (period: DashboardPeriod, from?: string, to?: string) =>
  useQuery({
    queryKey: ['dashboard', period, from, to],
    queryFn: () => api.get<DashboardSummary>(`/api/dashboard${qs({ period, from: period === 'CUSTOM' ? from : undefined, to: period === 'CUSTOM' ? to : undefined })}`),
    enabled: period !== 'CUSTOM' || (!!from && !!to && from <= to),
    placeholderData: (prev) => prev,
  });
