import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { CalendarCheck, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { APPOINTMENT_LIMITS, type FilterFieldDef, type ListFilter } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { ConfirmDialog, DateInput, Dropdown, Field, Modal, Spinner, TextArea, TextInput, validDate } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { todayISO } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';

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

  const save = useSave({ invalidate: [QUERY_KEY], onSuccess: onClose });
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

export default function AppointmentsPage() {
  // No sortBy: the API's own order (latest date, then latest time, then number) is the useful
  // one for daily work, and it cannot be expressed as a single column.
  const [state, setState] = useListState();
  const q = useList<Appointment>(QUERY_KEY, URL, state);
  const fmt = useDateFormatters();
  const [edit, setEdit] = useState<Appointment | null | undefined>(undefined);
  const [del, setDel] = useState<Appointment | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!state.search || state.filters.length > 0;

  /** The "Today" quick filter is an ordinary date filter — the Filter button owns ranges. */
  const todayFilter: ListFilter = { field: 'appointmentDate', op: 'equals', value: todayISO() };
  const isToday = state.filters.some((f) => f.field === 'appointmentDate' && f.op === 'equals' && f.value === todayFilter.value);

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
            <button
              type="button"
              className={isToday ? 'btn-outline-primary bg-primary/5' : 'btn-outline'}
              aria-pressed={isToday}
              onClick={() => setState({ filters: isToday ? state.filters.filter((f) => f.field !== 'appointmentDate') : [...state.filters.filter((f) => f.field !== 'appointmentDate'), todayFilter] })}
            >
              <CalendarCheck className="h-4 w-4" /> Today
            </button>
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => setState({ search: '', filters: [], page: 1 })}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching appointments' : 'No appointments yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Use New Appointment to book the first one.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for appointment ${r.appointmentNumber}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <AppointmentForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
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
