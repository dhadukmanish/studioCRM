import { useCallback, useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ACCOUNT_GROUP_LIMITS, HEAD_GROUPS, type FilterFieldDef, type HeadGroup } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, Drawer, Dropdown, Field, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtDate } from '@/lib/format';

const PERMISSION = 'masters_account_groups';
const URL = '/api/masters/account-groups';
const QUERY_KEY = 'account-groups';

interface AccountGroup {
  id: string;
  groupName: string;
  headGroup: HeadGroup;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The head group is a controlled choice — the API rejects anything outside this list. */
const headGroupOptions = HEAD_GROUPS.map((h) => ({ value: h, label: h }));

type FormValues = { groupName: string; headGroup: string; isActive: boolean };
const emptyForm: FormValues = { groupName: '', headGroup: '', isActive: true };

/* ------------------------------------------------------------------ form -- */

function AccountGroupForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: AccountGroup | null }) {
  const { register, handleSubmit, control, reset, setError, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm });
  useEffect(() => {
    if (open) reset(row ? { groupName: row.groupName, headGroup: row.headGroup, isActive: row.isActive } : emptyForm);
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
      title={row ? 'Edit Account Group' : 'Add Account Group'}
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
        <Field label="Account Group Name" required error={errors.groupName?.message} hint="E.g. CASH, BANK, CUSTOMER, PARTNER">
          <TextInput autoFocus placeholder="Enter account group name" maxLength={ACCOUNT_GROUP_LIMITS.groupName} {...register('groupName', { required: 'Account group name is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
        </Field>
        <Field label="Type (Head Group)" required error={errors.headGroup?.message}>
          <Controller
            control={control}
            name="headGroup"
            rules={{ required: 'Type is required' }}
            render={({ field }) => <Select value={field.value} onChange={field.onChange} options={headGroupOptions} placeholder="Select type" />}
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

export default function AccountGroupsPage() {
  const [state, setState] = useListState({ sortBy: 'updatedAt', sortOrder: 'desc' });
  const [headGroup, setHeadGroup] = useState('');
  const [status, setStatus] = useState('');
  const q = useList<AccountGroup>(QUERY_KEY, URL, state, { headGroup, isActive: status });
  const [edit, setEdit] = useState<AccountGroup | null | undefined>(undefined);
  const [del, setDel] = useState<AccountGroup | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!headGroup || !!status || !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'groupName', label: 'Account Group Name' },
    { key: 'headGroup', label: 'Type (Head Group)', type: 'select', options: headGroupOptions },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const columns: Column<AccountGroup>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'groupName', header: 'Account Group Name', render: (r) => <span className="font-medium text-gray-900">{r.groupName}</span> },
    { key: 'headGroup', header: 'Type (Head Group)' },
    { key: 'isActive', header: 'Status', render: (r) => <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmtDate(r.updatedAt) },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Masters' }, { label: 'Account Group Master' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Account Group Master</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'group' : 'groups'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Account Group</button>
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
        searchPlaceholder="Search by group name..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            {/* both quick filters live outside useListState, so each one resets the page itself */}
            <Select size="sm" className="w-[150px]" value={headGroup} onChange={(v) => { setHeadGroup(v); setState({ page: 1 }); }} placeholder="All Types" options={headGroupOptions} />
            <Select size="sm" className="w-[140px]" value={status} onChange={(v) => { setStatus(v); setState({ page: 1 }); }} placeholder="All Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => { setHeadGroup(''); setStatus(''); setState({ search: '', filters: [], page: 1 }); }}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching account groups' : 'No account groups yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Add the groups this studio files its accounts under.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${r.groupName}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <AccountGroupForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete account group?"
        message={<>Delete <b>"{del?.groupName}"</b>? This cannot be undone. To keep it for existing records, set it to Inactive instead.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
