import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { BOOK_LIMITS, BOOK_SERIES_START_DEFAULT, type FilterFieldDef } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, Drawer, Dropdown, Field, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtDate } from '@/lib/format';

const PERMISSION = 'masters_books';
const URL = '/api/masters/books';
const QUERY_KEY = 'books';

interface Book {
  id: string;
  bookNumber: string;
  seriesStartsAt: number;
  /** System-managed counter — read-only everywhere on this screen. */
  nextBillNumber: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A book that has handed out at least one number can no longer change where its series began. */
const seriesInUse = (b: Book) => b.nextBillNumber !== b.seriesStartsAt;

type FormValues = { bookNumber: string; seriesStartsAt: string; isActive: boolean };
const emptyForm: FormValues = { bookNumber: '', seriesStartsAt: String(BOOK_SERIES_START_DEFAULT), isActive: true };

/* ------------------------------------------------------------------ form -- */

function BookForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: Book | null }) {
  const { register, handleSubmit, control, reset, setError, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm });
  useEffect(() => {
    if (open) reset(row ? { bookNumber: row.bookNumber, seriesStartsAt: String(row.seriesStartsAt), isActive: row.isActive } : emptyForm);
  }, [open, row, reset]);

  const locked = !!row && seriesInUse(row);
  const save = useSave({ invalidate: [QUERY_KEY], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    // A locked series is not resubmitted at all: the API refuses a change, and sending the
    // unchanged value back would only make the request look like an attempted edit.
    const { seriesStartsAt, ...rest } = v;
    save.mutate(
      { method: row ? 'put' : 'post', url: row ? `${URL}/${row.id}` : URL, body: locked ? rest : v },
      { onError: (e) => applyApiErrors(e, setError as any) },
    );
  });

  // Ctrl/Cmd+S saves. Escape, focus trapping and focus restore belong to <Drawer>.
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

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="w-[400px]"
      title={row ? 'Edit Book' : 'Add Book'}
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
        <Field label="Book Number" required error={errors.bookNumber?.message} hint="E.g. 2026-27. Each book numbers its bills independently.">
          <TextInput autoFocus placeholder="Enter book number" maxLength={BOOK_LIMITS.bookNumber} {...register('bookNumber', { required: 'Book number is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
        </Field>
        <Field
          label="Series Starts At"
          required={!locked}
          error={errors.seriesStartsAt?.message}
          hint={locked ? `Locked — this book has already issued bill numbers. Next bill no. is ${row?.nextBillNumber}.` : 'The first bill number this book will use.'}
        >
          <TextInput
            inputMode="numeric"
            placeholder={String(BOOK_SERIES_START_DEFAULT)}
            disabled={locked}
            {...register('seriesStartsAt', { required: locked ? false : 'Series starts at is required' })}
          />
        </Field>
        <Field label="Status">
          <div className="flex h-10 items-center">
            <Controller control={control} name="isActive" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label={field.value ? 'Active' : 'Inactive'} />} />
          </div>
        </Field>
        {/* lets Enter submit from any field while the real buttons live in the drawer footer */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">Save</button>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function BooksPage() {
  const [state, setState] = useListState({ sortBy: 'updatedAt', sortOrder: 'desc' });
  const [status, setStatus] = useState('');
  const q = useList<Book>(QUERY_KEY, URL, state, { isActive: status });
  const [edit, setEdit] = useState<Book | null | undefined>(undefined);
  const [del, setDel] = useState<Book | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!status || !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'bookNumber', label: 'Book Number' },
    { key: 'seriesStartsAt', label: 'Series Starts At', type: 'number' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const columns: Column<Book>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'bookNumber', header: 'Book Number', render: (r) => <span className="font-medium text-gray-900">{r.bookNumber}</span> },
    { key: 'seriesStartsAt', header: 'Series Starts At' },
    /**
     * Read-only, and hidden by default: until Billing exists every book's next number still
     * equals its start, so showing both by default would only invite the reading that one is
     * a bill count. Available through the Columns button for anyone who wants it.
     */
    { key: 'nextBillNumber', header: 'Next Bill No.', hidden: true },
    { key: 'isActive', header: 'Status', render: (r) => <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmtDate(r.updatedAt) },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Masters' }, { label: 'Book Master' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Book Master</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'book' : 'books'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Book</button>
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
        searchPlaceholder="Search by book number..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            {/* the quick filter lives outside useListState, so it resets the page itself */}
            <Select size="sm" className="w-[140px]" value={status} onChange={(v) => { setStatus(v); setState({ page: 1 }); }} placeholder="All Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => { setStatus(''); setState({ search: '', filters: [], page: 1 }); }}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching books' : 'No books yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Add a book to open a bill number series.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${r.bookNumber}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <BookForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete book?"
        message={<>Delete <b>"{del?.bookNumber}"</b>? This cannot be undone. To close it to new bills while keeping its history, set it to Inactive instead.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
