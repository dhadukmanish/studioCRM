import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppointmentView, BillWorkStatus, DeliveryReport, DeliveryView, WorkPosition, WorkQueue, WorkStage, WorkStageOutcome, WorkView } from '@erp/shared';
import type { ListState } from '@/components/data/DataTable';
import { api, ApiError, qs } from '@/lib/api';
import { saveFile } from '@/lib/invoice';
import { toast } from '@/lib/toast';

/**
 * The studio workflow's data access (`apps/api/src/routes/work.ts`, docs/STUDIO_WORKFLOW.md).
 * Every position shown is the SERVER's — derived from the recorded stages there; nothing here
 * decides what the next stage is.
 *
 * One click changes a job, an appointment or a bill's payment, and several screens show the same
 * thing (the queue, the bill list, the bill, the reports), so every action invalidates `WORK_INVALIDATES`.
 */
export const WORK_KEY = 'work';
export const DELIVERY_KEY = 'delivery-report';
export const APPOINTMENTS_KEY = 'appointments';
export const WORK_INVALIDATES = [WORK_KEY, DELIVERY_KEY, 'bills', APPOINTMENTS_KEY];

const listQs = (s: ListState) => ({ page: s.page, limit: s.limit, search: s.search || undefined });

export const useBillWork = (billId?: string, enabled = true) =>
  useQuery({ queryKey: [WORK_KEY, 'bill', billId], queryFn: () => api.get<BillWorkStatus>(`/api/work/bills/${billId}`), enabled: !!billId && enabled });

export const useWorkQueue = (view: WorkView, list: ListState) =>
  useQuery({
    queryKey: [WORK_KEY, 'queue', view, list],
    queryFn: () => api.get<WorkQueue>(`/api/work/queue${qs({ view, ...listQs(list) })}`),
    placeholderData: (prev) => prev,
  });

export interface DeliveryFilters {
  view: DeliveryView;
  from?: string;
  to?: string;
}
export const useDeliveryReport = (f: DeliveryFilters, list: ListState) =>
  useQuery({
    queryKey: [DELIVERY_KEY, f, list],
    queryFn: () => api.get<DeliveryReport>(`/api/reports/delivery${qs({ ...f, ...listQs(list) })}`),
    placeholderData: (prev) => prev,
  });
export const fetchAllDeliveries = (f: DeliveryFilters, list: ListState) => api.get<DeliveryReport>(`/api/reports/delivery${qs({ ...f, search: list.search || undefined, full: 1 })}`);
export async function downloadDeliveryCsv(f: DeliveryFilters, list: ListState, today: string) {
  saveFile(await api.blob(`/api/reports/delivery/export${qs({ ...f, search: list.search || undefined })}`), `Delivery-${f.view.toLowerCase()}-${today}.csv`);
}

export interface AppointmentFilters {
  view: AppointmentView;
  from?: string;
  to?: string;
}
export async function downloadAppointmentsCsv(f: AppointmentFilters, list: ListState, today: string) {
  saveFile(await api.blob(`/api/appointments/export${qs({ ...f, search: list.search || undefined })}`), `Appointments-${f.view.toLowerCase()}-${today}.csv`);
}

/**
 * The one-click actions. Each toasts the server's message and refreshes every screen that shows it.
 * The row on Today's Work turns to its next step at once from the server's answer (a job's new
 * position, an appointment Done), before the refetch re-sorts the list — the next step appears
 * where the operator is looking.
 */
export function useWorkActions() {
  const qc = useQueryClient();
  const patchRow = (id: string, next: 'APPOINTMENT' | WorkPosition) =>
    qc.setQueriesData<WorkQueue>({ queryKey: [WORK_KEY, 'queue'] }, (old) => old && { ...old, rows: old.rows.map((r) => (r.id === id ? { ...r, next } : r)) });
  const done = (a: WorkAction, r: { message: string; data: unknown }) => {
    if (a.type === 'record' || a.type === 'reopen') patchRow(a.billId, (r.data as BillWorkStatus).position);
    else patchRow(a.id, a.type === 'appointment-done' ? 'COMPLETE' : 'APPOINTMENT');
    WORK_INVALIDATES.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    toast.success(r.message);
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong');
  return useMutation({
    mutationFn: (a: WorkAction) =>
      send(a).then((r) => (done(a, r), r.data)).catch((e) => { fail(e); throw e; }),
  });
}
function send(a: WorkAction) {
  switch (a.type) {
    case 'record':
      return api.raw<{ message: string; data: unknown }>('POST', `/api/work/bills/${a.billId}/stages/${a.stage}`, { outcome: a.outcome ?? 'DONE' });
    case 'reopen':
      return api.raw<{ message: string; data: unknown }>('DELETE', `/api/work/bills/${a.billId}/stages/${a.stage}`);
    case 'appointment-done':
      return api.raw<{ message: string; data: unknown }>('POST', `/api/appointments/${a.id}/done`);
    case 'appointment-reopen':
      return api.raw<{ message: string; data: unknown }>('POST', `/api/appointments/${a.id}/reopen`);
  }
}
export type WorkAction =
  | { type: 'record'; billId: string; stage: WorkStage; outcome?: WorkStageOutcome }
  | { type: 'reopen'; billId: string; stage: WorkStage }
  | { type: 'appointment-done'; id: string }
  | { type: 'appointment-reopen'; id: string };
