import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { GST_RATES, ITEM_LIMITS, formatGst, type FilterFieldDef } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, Drawer, Dropdown, Field, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { useDateFormatters } from '@/lib/settings';

const PERMISSION = 'masters_items';
const URL = '/api/masters/items';
const QUERY_KEY = 'items';

interface Item {
  id: string;
  itemName: string;
  hsnCode: string;
  gstRate: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GST is a controlled choice, never free text — the API rejects anything outside this list. */
const gstOptions = GST_RATES.map((r) => ({ value: String(r), label: formatGst(r) }));

type FormValues = { itemName: string; hsnCode: string; gstRate: string; isActive: boolean };
const emptyForm: FormValues = { itemName: '', hsnCode: '', gstRate: '', isActive: true };

/* ------------------------------------------------------------------ form -- */

function ItemForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: Item | null }) {
  const { register, handleSubmit, control, reset, setError, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm });
  useEffect(() => {
    if (open) reset(row ? { itemName: row.itemName, hsnCode: row.hsnCode, gstRate: String(row.gstRate), isActive: row.isActive } : emptyForm);
  }, [open, row, reset]);

  const save = useSave({ invalidate: [QUERY_KEY], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    save.mutate(
      { method: row ? 'put' : 'post', url: row ? `${URL}/${row.id}` : URL, body: v },
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
      title={row ? 'Edit Item' : 'Add Item'}
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
        <Field label="Item Name" required error={errors.itemName?.message}>
          <TextInput autoFocus placeholder="Enter item name" maxLength={ITEM_LIMITS.itemName} {...register('itemName', { required: 'Item name is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
        </Field>
        <Field label="HSN Code" required error={errors.hsnCode?.message}>
          <TextInput placeholder="Enter HSN code" maxLength={ITEM_LIMITS.hsnCode} {...register('hsnCode', { required: 'HSN code is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
        </Field>
        <Field label="GST %" required error={errors.gstRate?.message}>
          <Controller
            control={control}
            name="gstRate"
            rules={{ required: 'GST % is required' }}
            render={({ field }) => <Select value={field.value} onChange={field.onChange} options={gstOptions} placeholder="Select GST %" />}
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

export default function ItemsPage() {
  const [state, setState] = useListState({ sortBy: 'updatedAt', sortOrder: 'desc' });
  const [status, setStatus] = useState('');
  const q = useList<Item>(QUERY_KEY, URL, state, { isActive: status });
  const [edit, setEdit] = useState<Item | null | undefined>(undefined);
  const [del, setDel] = useState<Item | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!status || !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'itemName', label: 'Item Name' },
    { key: 'hsnCode', label: 'HSN Code' },
    { key: 'gstRate', label: 'GST %', type: 'select', options: gstOptions },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const fmt = useDateFormatters();

  const columns: Column<Item>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'itemName', header: 'Item Name', render: (r) => <span className="font-medium text-gray-900">{r.itemName}</span> },
    { key: 'hsnCode', header: 'HSN Code' },
    { key: 'gstRate', header: 'GST %', render: (r) => formatGst(r.gstRate) },
    { key: 'isActive', header: 'Status', render: (r) => <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmt.stamp(r.updatedAt) },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmt.stamp(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Masters' }, { label: 'Item Master' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Item Master</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'item' : 'items'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Item</button>
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
        searchPlaceholder="Search by item name, HSN..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            {/* changing the filter must go back to page 1 — `status` lives outside useListState */}
            <Select size="sm" className="w-[140px]" value={status} onChange={(v) => { setStatus(v); setState({ page: 1 }); }} placeholder="All Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => { setStatus(''); setState({ search: '', filters: [], page: 1 }); }}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching items' : 'No items yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Add the services and products this studio sells.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${r.itemName}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <ItemForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete item?"
        message={<>Delete <b>"{del?.itemName}"</b>? This cannot be undone. To keep it for existing records, set it to Inactive instead.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
