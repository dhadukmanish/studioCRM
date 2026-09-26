import { useQuery } from '@tanstack/react-query';
import type { BillDetailReport, BillPaymentStatus, BillReportCustomer, BillReportTab, BillSummaryReport, InvoiceTaxMode } from '@erp/shared';
import type { ListState } from '@/components/data/DataTable';
import { api, qs } from '@/lib/api';
import { saveFile } from '@/lib/invoice';

/**
 * Reports -> Bill Summary (`apps/api/src/routes/billReport.ts`, docs/BILL_SUMMARY_REPORT.md).
 * Both tabs send the SAME scope; every row, total and figure is the server's.
 */
const URL = '/api/reports/bills';
export const BILL_REPORT_KEY = 'bill-report';

/** The filter scope both tabs share. Empty dates = the server's default (this month). */
export interface BillReportScope {
  from?: string;
  to?: string;
  customer?: string;
  bookId?: string;
  seriesType?: InvoiceTaxMode;
  billNumber?: string;
  paymentStatus?: BillPaymentStatus;
}

export type BillReportData<T extends BillReportTab> = T extends 'summary' ? BillSummaryReport : BillDetailReport;

const listQs = (s: ListState) => ({ page: s.page, limit: s.limit, search: s.search || undefined, sortBy: s.sortBy, sortOrder: s.sortBy ? s.sortOrder : undefined });

export const useBillReport = <T extends BillReportTab>(tab: T, scope: BillReportScope, list: ListState) =>
  useQuery({
    queryKey: [BILL_REPORT_KEY, tab, scope, list],
    queryFn: () => api.get<BillReportData<T>>(`${URL}/${tab}${qs({ ...scope, ...listQs(list) })}`),
    placeholderData: (prev) => prev,
  });

/** Every row of the filtered result (print / preview). The server refuses — never truncates — past its row ceiling. */
export const fetchWholeBillReport = <T extends BillReportTab>(tab: T, scope: BillReportScope, list: ListState) =>
  api.get<BillReportData<T>>(`${URL}/${tab}${qs({ ...scope, ...listQs(list), page: 1, limit: undefined, full: 1 })}`);

/** The server-built CSV of the whole filtered result — same scope and sort as the screen. */
export async function downloadBillReportCsv(tab: BillReportTab, scope: BillReportScope, list: ListState, range: string) {
  const blob = await api.blob(`${URL}/export${qs({ tab, ...scope, ...listQs(list), page: undefined, limit: undefined })}`);
  saveFile(blob, `Bill-${tab === 'summary' ? 'Summary' : 'Detailed'}-${range}.csv`);
}

export const useBillReportCustomers = (search: string, enabled: boolean) =>
  useQuery({
    queryKey: [BILL_REPORT_KEY, 'customers', search],
    queryFn: () => api.get<BillReportCustomer[]>(`${URL}/customers${qs({ search: search || undefined })}`),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
    enabled,
  });

/** One customer by key — the chosen customer's name after a reload (the URL carries only the key). */
export const useBillReportCustomer = (key?: string) =>
  useQuery({
    queryKey: [BILL_REPORT_KEY, 'customer', key],
    queryFn: () => api.get<BillReportCustomer[]>(`${URL}/customers${qs({ key })}`),
    enabled: !!key,
    staleTime: 60_000,
    select: (rows) => rows[0] ?? null,
  });
