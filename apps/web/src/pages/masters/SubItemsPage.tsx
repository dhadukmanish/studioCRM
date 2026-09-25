import { useCallback, useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { SUB_ITEM_LIMITS, type FilterFieldDef } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, Combobox, ConfirmDialog, Drawer, Dropdown, Field, Select, Spinner, Switch, TextArea, TextInput, type Option } from '@/components/ui';
import { applyApiErrors, useItemsLookup, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtNum } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';

const PERMISSION = 'masters_sub_items';
const URL = '/api/masters/sub-items';
const QUERY_KEY = 'sub-items';

interface SubItem {
  id: string;
  itemId: string;
  /** joined from Item Master by the list endpoint — GST % and HSN stay on the parent item */
  itemName: string | null;
  productName: string;
  rate: number;
  remark: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type FormValues = { itemId: string; productName: string; rate: string; remark: string; isActive: boolean };
const emptyForm: FormValues = { itemId: '', productName: '', rate: '', remark: '', isActive: true };

/* ------------------------------------------------------------------ form -- */

function SubItemForm({ open, onClose, row, itemOptions }: { open: boolean; onClose: () => void; row?: SubItem | null; itemOptions: Option[] }) {
  const { register, handleSubmit, control, reset, setError, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm });
  useEffect(() => {
    if (open) reset(row ? { itemId: row.itemId, productName: row.productName, rate: String(row.rate), remark: row.remark ?? '', isActive: row.isActive } : emptyForm);
  }, [open, row, reset]);

  /**
   * The lookup only offers active items, so a record whose parent was later deactivated would
   * otherwise render as a bare id. Keep showing the parent it already has — editing a product
   * must never silently re-point it at a different item.
   */
  const options = useMemo(() => {
    if (!row?.itemId || itemOptions.some((o) => o.value === row.itemId)) return itemOptions;
    return [{ value: row.itemId, label: row.itemName ?? 'Unknown item', sub: '(inactive)' }, ...itemOptions];
  }, [itemOptions, row]);

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
      title={row ? 'Edit Sub Item' : 'Add Sub Item'}
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
        <Field label="Item Name" required error={errors.itemId?.message} hint="Select the parent item under which this product belongs.">
          <Controller
            control={control}
            name="itemId"
            rules={{ required: 'Item is required' }}
            render={({ field }) => <Combobox value={field.value} onChange={field.onChange} options={options} placeholder="Select item" />}
          />
        </Field>
        <Field label="Product Name" required error={errors.productName?.message}>
          {/* no autoFocus: <Drawer> opens on the first field in the body, which is the item picker */}
          <TextInput placeholder="Enter product name" maxLength={SUB_ITEM_LIMITS.productName} {...register('productName', { required: 'Product name is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
        </Field>
        <Field label="Rate (₹)" required error={errors.rate?.message}>
          <TextInput inputMode="decimal" placeholder="0.00" {...register('rate', { required: 'Rate is required' })} />
        </Field>
        <Field label={<>Remark <span className="font-normal text-gray-500">(Optional)</span></>} error={errors.remark?.message}>
          <TextArea rows={3} placeholder="Enter remark (optional)" maxLength={SUB_ITEM_LIMITS.remark} {...register('remark')} />
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

export default function SubItemsPage() {
  const [state, setState] = useListState({ sortBy: 'updatedAt', sortOrder: 'desc' });
  const [itemId, setItemId] = useState('');
  const [status, setStatus] = useState('');
  const q = useList<SubItem>(QUERY_KEY, URL, state, { itemId, isActive: status });
  const items = useItemsLookup();
  const [edit, setEdit] = useState<SubItem | null | undefined>(undefined);
  const [del, setDel] = useState<SubItem | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!itemId || !!status || !!state.search || state.filters.length > 0;
  const itemOptions: Option[] = useMemo(() => (items.data ?? []).map((i) => ({ value: i.id, label: i.itemName })), [items.data]);

  const filterFields: FilterFieldDef[] = [
    { key: 'itemName', label: 'Item Name' },
    { key: 'productName', label: 'Product Name' },
    { key: 'rate', label: 'Rate', type: 'number' },
    { key: 'remark', label: 'Remark' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const fmt = useDateFormatters();

  const columns: Column<SubItem>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'itemName', header: 'Item Name', render: (r) => r.itemName ?? '-' },
    { key: 'productName', header: 'Product Name', render: (r) => <span className="font-medium text-gray-900">{r.productName}</span> },
    // The rupee sign lives in the header, so the column stays a clean stack of numbers.
    { key: 'rate', header: 'Rate (₹)', render: (r) => fmtNum(r.rate) },
    { key: 'isActive', header: 'Status', render: (r) => <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmt.stamp(r.updatedAt) },
    { key: 'remark', header: 'Remark', hidden: true, render: (r) => <span className="text-gray-600">{r.remark || '-'}</span> },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmt.stamp(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Masters' }, { label: 'Sub Item Master' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Sub Item Master</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'item' : 'items'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Sub Item</button>
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
        searchPlaceholder="Search by product name..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            {/* both quick filters live outside useListState, so each one resets the page itself */}
            <Combobox size="sm" className="w-[170px]" value={itemId} onChange={(v) => { setItemId(v); setState({ page: 1 }); }} placeholder="All Items" options={itemOptions} />
            <Select size="sm" className="w-[140px]" value={status} onChange={(v) => { setStatus(v); setState({ page: 1 }); }} placeholder="All Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => { setItemId(''); setStatus(''); setState({ search: '', filters: [], page: 1 }); }}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching sub items' : 'No sub items yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Add the products this studio bills under each item.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${r.productName}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <SubItemForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} itemOptions={itemOptions} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete sub item?"
        message={<>Delete <b>"{del?.productName}"</b>? This cannot be undone. To keep it for existing records, set it to Inactive instead.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
