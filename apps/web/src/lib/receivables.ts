import { useQuery } from '@tanstack/react-query';
import type {
  AgingBucket,
  ReceivableBillRow,
  ReceivableBillStatus,
  ReceivableCustomerDetail,
  ReceivableCustomerRow,
  ReceivablesExport,
  ReceivablesOverview,
  ReceivablesPage,
} from '@erp/shared';
import type { ListState } from '@/components/data/DataTable';
import { api, qs } from '@/lib/api';
import { saveFile } from '@/lib/invoice';

/**
 * Receivables reports' data access (`apps/api/src/routes/receivables.ts`). Every figure is the
 * SERVER's — Paid, Outstanding, ages, buckets and every total are computed in SQL there and never
 * re-added here. Keys start with `RECEIVABLES_KEY`; a receipt save/cancel invalidates it.
 */
export const RECEIVABLES_KEY = 'receivables';
const URL = '/api/reports/receivables';

/** The scope every view shares. No `asOf` means "today in the company's time zone" — the server decides. */
export interface ReceivablesScope {
  asOf?: string;
  from?: string;
  to?: string;
  bookId?: string;
}
export interface CustomerListFilters {
  all?: boolean;
}
export interface BillListFilters {
  status?: ReceivableBillStatus;
  bucket?: AgingBucket;
  customer?: string;
}

const listQs = (s: ListState) => ({ page: s.page, limit: s.limit, search: s.search, sortBy: s.sortBy, sortOrder: s.sortOrder });

export const useReceivablesOverview = (scope: ReceivablesScope) =>
  useQuery({ queryKey: [RECEIVABLES_KEY, 'overview', scope], queryFn: () => api.get<ReceivablesOverview>(`${URL}/overview${qs({ ...scope })}`), placeholderData: (prev) => prev });

export const useCustomerSummaryReport = (scope: ReceivablesScope, list: ListState, f: CustomerListFilters) =>
  useQuery({
    queryKey: [RECEIVABLES_KEY, 'customers', scope, list, f],
    queryFn: () => api.get<ReceivablesPage<ReceivableCustomerRow>>(`${URL}/customers${qs({ ...scope, ...listQs(list), all: f.all ? 1 : undefined })}`),
    placeholderData: (prev) => prev,
  });

export const useBillReceivablesReport = (scope: ReceivablesScope, list: ListState, f: BillListFilters, enabled = true) =>
  useQuery({
    queryKey: [RECEIVABLES_KEY, 'bills', scope, list, f],
    queryFn: () => api.get<ReceivablesPage<ReceivableBillRow>>(`${URL}/bills${qs({ ...scope, ...listQs(list), ...f })}`),
    placeholderData: (prev) => prev,
    enabled,
  });

export const useCustomerReceivableDetail = (key: string | undefined, scope: ReceivablesScope) =>
  useQuery({
    queryKey: [RECEIVABLES_KEY, 'customer', key, scope],
    queryFn: () => api.get<ReceivableCustomerDetail>(`${URL}/customers/${encodeURIComponent(key!)}${qs({ ...scope })}`),
    enabled: !!key,
  });

/** Every row of the filtered result (print). The server refuses — never truncates — past its row ceiling. */
export const fetchAllCustomers = (scope: ReceivablesScope, list: ListState, f: CustomerListFilters) =>
  api.get<ReceivablesPage<ReceivableCustomerRow>>(`${URL}/customers${qs({ ...scope, ...listQs(list), page: 1, all: f.all ? 1 : undefined, full: 1 })}`);
export const fetchAllBills = (scope: ReceivablesScope, list: ListState, f: BillListFilters) =>
  api.get<ReceivablesPage<ReceivableBillRow>>(`${URL}/bills${qs({ ...scope, ...listQs(list), page: 1, ...f, full: 1 })}`);

/** The server-built CSV of the whole filtered result — the same filters and sort as the screen. */
export async function downloadReceivablesCsv(report: ReceivablesExport, asOf: string, scope: ReceivablesScope, list: ListState, extra: Record<string, unknown>) {
  const blob = await api.blob(`${URL}/export${qs({ report, ...scope, ...listQs(list), page: undefined, limit: undefined, ...extra })}`);
  const name = { customers: 'Receivables-Summary', bills: 'Outstanding-Bills', aging: 'Receivables-Aging' }[report];
  saveFile(blob, `${name}-as-of-${scope.asOf ?? asOf}.csv`);
}

/** Where the drill-down lives, carrying the report scope so its header matches the row clicked. */
export const receivableCustomerHref = (key: string, scope: ReceivablesScope) =>
  `/modules/reports/receivables/customers/${encodeURIComponent(key)}${qs({ asOf: scope.asOf, from: scope.from, to: scope.to, book: scope.bookId })}`;
