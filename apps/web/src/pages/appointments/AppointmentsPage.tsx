import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, HandCoins, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { APPOINTMENT_LIMITS, APPOINTMENT_VIEWS, APPOINTMENT_VIEW_LABELS, normalizeMobile, type AppointmentView, type FilterFieldDef } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, DateInput, Dropdown, Field, Modal, Spinner, TextArea, TextInput, validDate } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { cx, todayISO } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { ReceivePaymentDialog, type ReceivePaymentFor } from '@/pages/receipts/ReceivePaymentDialog';
import { useWorkActions } from '@/lib/work';

const PERMISSION = 'operations_appointments';
const URL = '/api/appointments';
const QUERY_KEY = 'appointments';

interface Appointment {
  id: string;
  /** System-issued, one sequence per tenant. Read-only everywhere on this screen. */
  appointmentNumber: number;
  /** "YYYY-MM-DD" — a plain calendar date, never parsed as a timestamp. */
  appointmentDate: string;
  /** "HH:MM" local clock time, or null when the hour is not settled yet. */
  appointmentTime: string | null;
  customerName: string;
  mobileNumber: string;
  babyName: string | null;
  remark: string | null;
  /** Set when a bill's Next Visit Date created this booking. */
  sourceBillId: string | null;
  /** When it was marked Done; null = pending. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type FormValues = { appointmentDate: string; appointmentTime: string; customerName: string; mobileNumber: string; babyName: string; remark: string };

/**
 * A new booking defaults to today because that is when most of them are taken; the time stays
 * blank, because an appointment is often agreed for a day before the hour is. `todayISO` reads
 * the browser's local date — never the UTC one, which is still yesterday in India until 05:30.
 */
const emptyForm = (): FormValues => ({ appointmentDate: todayISO(), appointmentTime: '', customerName: '', mobileNumber: '', babyName: '', remark: '' });

/* ------------------------------------------------------------------ form -- */

/** One form for Add and Edit. The appointment number is never editable. */
function AppointmentForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: Appointment | null }) {
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm() });
  useEffect(() => {
    if (!open) return;
    reset(
      row
        ? {
            appointmentDate: row.appointmentDate,
            appointmentTime: row.appointmentTime ?? '',
            customerName: row.customerName,
            mobileNumber: row.mobileNumber,
            babyName: row.babyName ?? '',
            remark: row.remark ?? '',
          }
        : emptyForm(),
    );
  }, [open, row, reset]);

  const save = useSave({ invalidate: [QUERY_KEY, 'work'], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    save.mutate({ method: row ? 'put' : 'post', url: row ? `${URL}/${row.id}` : URL, body: v }, { onError: (e) => applyApiErrors(e, setError as any) });
  });

  // Ctrl/Cmd+S saves. Escape, focus trapping and focus restore belong to <Modal>.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); submit(); }
    },
    [submit],
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onKey]);

  const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

  return (
    <Modal
      open={open}
      onClose={onClose}
      /** lg = 760px: room for two comfortable columns, without Account Master's 1000px. */
      size="lg"
      title={row ? `Edit Appointment #${row.appointmentNumber}` : 'New Appointment'}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={submit} disabled={save.isPending}>
            {save.isPending && <Spinner />} {row ? 'Update' : 'Save'}
          </button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {!row && <p className="text-[12.5px] text-gray-500">Appointment No. is generated automatically when you save.</p>}
        {/* tab order follows the operator's reading order: date, time, customer, mobile, baby, remark */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Appointment Date" required error={errors.appointmentDate?.message}>
            <Controller control={control} name="appointmentDate" rules={{ required: 'Appointment date is required', validate: validDate }} render={({ field }) => <DateInput {...field} autoFocus />} />
          </Field>
          <Field label="Time" error={errors.appointmentTime?.message} hint="Optional — leave blank if the time is not fixed yet.">
            <TextInput type="time" {...register('appointmentTime')} />
          </Field>
          <Field label="Customer Name" required error={errors.customerName?.message}>
            <TextInput placeholder="Enter customer name" maxLength={APPOINTMENT_LIMITS.customerName} {...register('customerName', { required: 'Customer name is required', setValueAs: trimmed })} />
          </Field>
          <Field label="Mobile No." required error={errors.mobileNumber?.message} hint="Billing will find this booking by its mobile number.">
            <TextInput inputMode="tel" placeholder="Enter mobile no." maxLength={APPOINTMENT_LIMITS.mobileNumber} {...register('mobileNumber', { required: 'Mobile no. is required', setValueAs: trimmed })} />
          </Field>
          <Field label="Baby Name" error={errors.babyName?.message}>
            <TextInput placeholder="Enter baby name" maxLength={APPOINTMENT_LIMITS.babyName} {...register('babyName', { setValueAs: trimmed })} />
          </Field>
          <Field label="Remark" error={errors.remark?.message} className="sm:col-span-2">
            <TextArea rows={2} placeholder="Optional note" maxLength={APPOINTMENT_LIMITS.remark} {...register('remark', { setValueAs: trimmed })} />
          </Field>
        </div>
        {/* lets Enter submit from any field while the real buttons live in the modal footer */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">Save</button>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ page -- */

/**
 * What each quick view is for — also its empty state. PENDING is the default: the screen is a work
 * queue first, and a Done appointment leaves it the moment it is marked (it stays under Done / All).
 */
const EMPTY: Record<AppointmentView, string> = {
  TODAY: 'No appointments pending today.',
  UPCOMING: 'No upcoming appointments.',
  PENDING: 'No appointments pending.',
  DONE: 'No appointments done yet.',
  ALL: 'No appointments yet.',
};

export default function AppointmentsPage() {
  // No sortBy: each view has its own useful order (Pending soonest first, Done latest first) that
  // a single column cannot express — the API applies it.
  const [state, setState] = useListState();
  const [view, setView] = useState<AppointmentView>('PENDING');
  const q = useList<Appointment>(QUERY_KEY, URL, state, { view }) as ReturnType<typeof useList<Appointment>> & { data?: { today: string; counts: Record<AppointmentView, number> } };
  const fmt = useDateFormatters();
  const nav = useNavigate();
  const [edit, setEdit] = useState<Appointment | null | undefined>(undefined);
  const [del, setDel] = useState<Appointment | null>(null);
  const [paying, setPaying] = useState<ReceivePaymentFor | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY, 'work'], onSuccess: () => setDel(null) });
  const act = useWorkActions();

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const canReceive = can('operations_receipts', 'create');
  const filtered = !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'appointmentDate', label: 'Appointment Date', type: 'date' },
    { key: 'appointmentNumber', label: 'Appointment No.', type: 'number' },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'mobileNumber', label: 'Mobile No.' },
    { key: 'babyName', label: 'Baby Name' },
    { key: 'remark', label: 'Remark' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const columns: Column<Appointment>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'appointmentNumber', header: 'Appointment No.', render: (r) => <span className="font-medium text-gray-900">{r.appointmentNumber}</span> },
    { key: 'appointmentDate', header: 'Date', render: (r) => fmt.date(r.appointmentDate) },
    { key: 'appointmentTime', header: 'Time', render: (r) => fmt.time(r.appointmentTime) },
    { key: 'customerName', header: 'Customer Name' },
    { key: 'mobileNumber', header: 'Mobile No.' },
    { key: 'babyName', header: 'Baby Name', render: (r) => r.babyName || '-' },
    /** Text first, colour second. A next-visit booking says where it came from. */
    {
      key: 'completedAt',
      header: 'Status',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <Badge color={r.completedAt ? 'green' : 'amber'}>{r.completedAt ? 'Done' : 'Pending'}</Badge>
          {r.sourceBillId && <span className="text-[12px] text-gray-500">Next visit</span>}
        </span>
      ),
    },
    /** Hidden by default: it is free text of any length and would dominate the row width. */
    { key: 'remark', header: 'Remark', hidden: true, render: (r) => r.remark || '-' },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmt.stamp(r.updatedAt) },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmt.stamp(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Appointments' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Appointments</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'appointment' : 'appointments'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> New Appointment</button>
          )}
        </div>
      </div>

      <DataTable
        storageKey={QUERY_KEY}
        columnsButton
        dense
        columns={columns}
        rows={q.data?.rows ?? []}
        total={total}
        loading={q.isFetching}
        state={state}
        onStateChange={setState}
        rowKey={(r) => r.id}
        onRefresh={() => q.refetch()}
        filterFields={filterFields}
        searchPlaceholder="Search by no., customer, mobile or baby name..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {APPOINTMENT_VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => {
                    setView(v);
                    setState({ page: 1 });
                  }}
                  className={cx(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition max-sm:h-9',
                    view === v ? 'border-primary/40 bg-primary-50 font-medium text-primary-dark' : 'border-line bg-surface text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {APPOINTMENT_VIEW_LABELS[v]}
                  <span className={cx('tabular-nums', view === v ? 'text-primary-dark' : 'text-gray-400')}>{q.data?.counts?.[v] ?? '·'}</span>
                </button>
              ))}
            </div>
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => setState({ search: '', filters: [], page: 1 })}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching appointments' : EMPTY[view]}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : view === 'ALL' ? 'Use New Appointment to book the first one.' : undefined}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1.5">
            {/* The routine action is visible and one click — no form, no status dropdown. */}
            {!r.completedAt && canEdit && (
              <button
                type="button"
                className="btn-outline-primary h-7 px-2 text-[12.5px] max-sm:h-9 max-sm:px-3"
                aria-label={`Mark appointment ${r.appointmentNumber} done`}
                disabled={act.isPending}
                onClick={() => act.mutate({ type: 'appointment-done', id: r.id })}
              >
                <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> Done
              </button>
            )}
            {(canEdit || canDelete || canReceive) && (
              <Dropdown
                trigger={<button type="button" className="row-action max-sm:h-9 max-sm:w-9" title="Actions" aria-label={`Actions for appointment ${r.appointmentNumber}`}>…</button>}
                items={[
                  ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                  ...(canEdit && r.completedAt ? [{ label: 'Mark as pending', icon: <RotateCcw className="h-3.5 w-3.5" />, onClick: () => act.mutate({ type: 'appointment-reopen', id: r.id }) }] : []),
                  ...(canReceive ? [{ label: 'Receive payment', icon: <HandCoins className="h-3.5 w-3.5" />, onClick: () => setPaying({ customerKey: normalizeMobile(r.mobileNumber), customerName: r.customerName }) }] : []),
                  ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
                ]}
              />
            )}
          </div>
        )}
      />

      <AppointmentForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ReceivePaymentDialog open={!!paying} onClose={() => setPaying(null)} payment={paying} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete appointment?"
        message={<>Delete appointment <b>#{del?.appointmentNumber}</b> for <b>"{del?.customerName}"</b>? This cannot be undone.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
