import { useState } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_VIEWS,
  APPOINTMENT_VIEW_LABELS,
  type AppointmentStatus,
  type AppointmentView,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { useList, type Page } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { APPOINTMENTS_KEY, downloadAppointmentsCsv, useWorkActions, type AppointmentFilters } from '@/lib/work';
import { DateRange, ReportActions, ViewChips, rangeText, useBusyAction, useReportPrint } from './reportKit';

/**
 * Reports -> Appointments: the same appointments the Appointments screen keeps, seen by view —
 * Today, Upcoming, Pending (default; a missed one stays until someone deals with it), Done, All.
 * One click marks a pending appointment Done; reopening belongs to the Appointments screen.
 */
interface AppointmentRow {
  id: string;
  appointmentNumber: number;
  /** "YYYY-MM-DD" — a plain calendar date, never parsed as a timestamp. */
  appointmentDate: string;
  appointmentTime: string | null;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  remark: string | null;
  /** Set when a bill's Next Visit Date created this appointment. */
  sourceBillId: string | null;
  status: AppointmentStatus;
  completedAt: string | null;
}
type AppointmentReport = Page<AppointmentRow> & { today: string; counts: Record<AppointmentView, number> };

const URL = '/api/appointments';
const EMPTY: Record<AppointmentView, string> = {
  TODAY: 'No appointments pending today.',
  UPCOMING: 'No upcoming appointments.',
  PENDING: 'No appointments pending.',
  DONE: 'No appointments done yet.',
  ALL: 'No appointments yet.',
};
const DASH = '—';

const StatusBadge = ({ status }: { status: AppointmentStatus }) => <Badge color={status === 'DONE' ? 'green' : 'amber'}>{APPOINTMENT_STATUS_LABELS[status]}</Badge>;

export default function AppointmentReportPage() {
  // No default sortBy: each view's own server order (Pending oldest first, …) is the useful one.
  const [list, setList] = useListState({ limit: 20 });
  const [f, setF] = useState<AppointmentFilters>({ view: 'PENDING' });
  const q = useList<AppointmentRow>(APPOINTMENTS_KEY, URL, list, { view: f.view, from: f.from, to: f.to });
  const data = q.data as AppointmentReport | undefined;
  const fmt = useDateFormatters();
  const canDone = useAuthStore((s) => s.can)('operations_appointments', 'update');
  const act = useWorkActions();
  const print = useReportPrint();
  const csv = useBusyAction('The CSV could not be exported');
  const filtered = !!list.search || !!f.from || !!f.to;
  const change = (p: Partial<AppointmentFilters>) => { setF((s) => ({ ...s, ...p })); setList({ page: 1 }); };

  const source = (r: AppointmentRow) => (r.sourceBillId ? 'Next visit' : DASH);
  const muted = (text: string) => <span className="text-gray-400">{text}</span>;

  const columns: Column<AppointmentRow>[] = [
    { key: 'appointmentNumber', header: 'No.', locked: true, render: (r) => <span className="font-medium text-gray-900">{r.appointmentNumber}</span> },
    { key: 'appointmentDate', header: 'Date', render: (r) => fmt.date(r.appointmentDate) },
    { key: 'appointmentTime', header: 'Time', render: (r) => (r.appointmentTime ? fmt.time(r.appointmentTime) : muted(DASH)) },
    { key: 'customerName', header: 'Customer', render: (r) => <span className="block max-w-[170px] truncate" title={r.customerName}>{r.customerName}</span> },
    { key: 'mobileNumber', header: 'Mobile' },
    { key: 'babyName', header: 'Baby', render: (r) => r.babyName || muted(DASH) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'completedAt', header: 'Done At', render: (r) => (r.completedAt ? fmt.stamp(r.completedAt) : muted(DASH)) },
    { key: 'sourceBillId', header: 'Source', hidden: true, sortable: false, render: (r) => (r.sourceBillId ? 'Next visit' : muted(DASH)) },
    { key: 'remark', header: 'Remark', hidden: true, render: (r) => (r.remark ? <span className="block max-w-[220px] truncate" title={r.remark}>{r.remark}</span> : muted(DASH)) },
  ];

  const printIt = () =>
    print.run(async () => {
      const d = await api.get<AppointmentReport>(`${URL}${qs({ view: f.view, from: f.from, to: f.to, search: list.search || undefined, sortBy: list.sortBy, sortOrder: list.sortBy ? list.sortOrder : undefined, full: 1 })}`);
      return {
        title: 'Appointments Report',
        caption: [APPOINTMENT_VIEW_LABELS[f.view], rangeText('Appointment date', f.from, f.to, fmt.date), list.search && `Search "${list.search}"`].filter(Boolean).join(' · '),
        summary: [{ label: 'Appointments', value: String(d.total) }],
        headers: ['No.', 'Date', 'Time', 'Customer', 'Mobile', 'Baby', 'Status', 'Done At', 'Source', 'Remark'],
        numeric: [0],
        rows: d.rows.map((r) => [
          String(r.appointmentNumber),
          fmt.date(r.appointmentDate),
          r.appointmentTime ? fmt.time(r.appointmentTime) : DASH,
          r.customerName,
          r.mobileNumber,
          r.babyName || DASH,
          APPOINTMENT_STATUS_LABELS[r.status],
          r.completedAt ? fmt.stamp(r.completedAt) : DASH,
          source(r),
          r.remark || DASH,
        ]),
        totals: [`${d.total} ${d.total === 1 ? 'appointment' : 'appointments'}`, '', '', '', '', '', '', '', '', ''],
        landscape: true,
      };
    });

  const doneButton = (r: AppointmentRow) =>
    canDone && r.status === 'PENDING' ? (
      <button
        type="button"
        className="btn-outline-primary h-7 px-2.5 text-[13px] max-sm:h-9"
        disabled={act.isPending && act.variables?.type === 'appointment-done' && act.variables.id === r.id}
        aria-label={`Mark appointment ${r.appointmentNumber} done`}
        onClick={() => act.mutate({ type: 'appointment-done', id: r.id })}
      >
        <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Done
      </button>
    ) : null;

  return (
    <>
      <Crumb items={[{ label: 'Reports' }, { label: 'Appointments' }]} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Appointments report</h2>
          {data?.today && <span className="text-[13px] text-gray-500">Today {fmt.date(data.today)}</span>}
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
      </div>

      <ViewChips label="Appointment view" views={APPOINTMENT_VIEWS} labels={APPOINTMENT_VIEW_LABELS} counts={data?.counts} value={f.view} onChange={(view) => change({ view })} />

      <DataTable
        storageKey="appointments-report"
        columnsButton
        dense
        compact
        columns={columns}
        rows={data?.rows ?? []}
        total={data?.total ?? 0}
        loading={q.isFetching}
        state={list}
        onStateChange={setList}
        rowKey={(r) => r.id}
        filterFields={false}
        searchPlaceholder="Search no., customer, mobile or baby..."
        toolbar={<DateRange label="Appointment date" from={f.from} to={f.to} onChange={(r) => change(r)} />}
        actions={<ReportActions onPrint={printIt} onCsv={() => csv.run(() => downloadAppointmentsCsv(f, list, data?.today ?? ''))} printing={print.busy} exporting={csv.busy} />}
        onRefresh={() => q.refetch()}
        emptyTitle={q.isError ? 'The report could not be loaded' : filtered ? 'No matching appointments' : EMPTY[f.view]}
        emptyDescription={
          q.isError ? (
            <>
              {q.error instanceof ApiError && <span className="block">{q.error.message}</span>}
              <button type="button" className="link" onClick={() => q.refetch()}>Retry</button>
            </>
          ) : filtered ? 'Try a different search or date range.' : undefined
        }
        rowActions={doneButton}
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-gray-900">#{r.appointmentNumber} · {r.customerName}</span>
              <span className="whitespace-nowrap text-[13px] text-gray-600">{fmt.date(r.appointmentDate)}{r.appointmentTime && ` ${fmt.time(r.appointmentTime)}`}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-gray-500">
              <StatusBadge status={r.status} />
              <span>{r.mobileNumber}</span>
              {r.babyName && <span>{r.babyName}</span>}
              {r.completedAt && <span>Done {fmt.stamp(r.completedAt)}</span>}
            </div>
          </div>
        )}
      />
      {print.sheet}
    </>
  );
}
