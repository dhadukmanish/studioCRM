import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Copy, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { PermissionGrants } from '@erp/shared';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { PermissionMatrix } from '@/components/data/PermissionMatrix';
import { Badge, ConfirmDialog, Field, Modal, Spinner, Switch, TextArea, TextInput } from '@/components/ui';
import { applyApiErrors, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';

type Role = { id: string; key: string | null; name: string; description: string | null; permissions: PermissionGrants; isSystem: boolean; isActive: boolean; userCount: number };

function RoleForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: Role | null }) {
  const { register, handleSubmit, reset, watch, setValue, setError, formState: { errors } } = useForm<{ name: string; description: string; isActive: boolean; permissions: PermissionGrants }>({ defaultValues: { name: '', description: '', isActive: true, permissions: {} } });
  useEffect(() => { if (open) reset(row ? { name: row.name, description: row.description ?? '', isActive: row.isActive, permissions: row.permissions ?? {} } : { name: '', description: '', isActive: true, permissions: {} }); }, [open, row, reset]);
  const save = useSave({ invalidate: ['roles', 'lookup'], onSuccess: onClose });
  const submit = handleSubmit((v) => save.mutate({ method: row ? 'put' : 'post', url: row ? `/api/admin/roles/${row.id}` : '/api/admin/roles', body: v }, { onError: (e) => applyApiErrors(e, setError as any) }));
  const isSuper = row?.key === 'super_admin';
  const perms = watch('permissions');
  return (
    <Modal open={open} onClose={onClose} size="xl" title={row ? `Edit Role — ${row.name}` : 'Add Role'} footer={<><button className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending && <Spinner />} {row ? 'Update' : 'Save'}</button></>}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Role Name" required error={errors.name?.message}><TextInput {...register('name', { required: 'Role name is required' })} disabled={row?.isSystem} placeholder="e.g. Sales Executive" /></Field>
          <Field label="Description"><TextInput {...register('description')} placeholder="What this role is for" /></Field>
          <Field label="Status"><div className="flex h-10 items-center"><Switch checked={watch('isActive')} onChange={(v) => setValue('isActive', v)} disabled={row?.isSystem} label={watch('isActive') ? 'Active' : 'Inactive'} /></div></Field>
        </div>
        {isSuper ? (
          <p className="flex items-center gap-2 rounded-lg bg-primary-lighter/50 px-4 py-3 text-[13px] text-primary-dark"><ShieldCheck className="h-4 w-4" /> Super Admin always has every permission. It cannot be restricted.</p>
        ) : (
          <PermissionMatrix value={perms} onChange={(g) => setValue('permissions', g, { shouldDirty: true })} />
        )}
        {row?.isSystem && !isSuper && <p className="text-[12px] text-gray-500">System role — name cannot change, but permissions can be tuned for your organisation.</p>}
      </form>
    </Modal>
  );
}

export default function RolesPage() {
  const [state, setState] = useListState({ sortOrder: 'asc' });
  const q = useList<Role>('roles', '/api/admin/roles', state);
  const [edit, setEdit] = useState<Role | null | undefined>(undefined);
  const [del, setDel] = useState<Role | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: ['roles', 'lookup'], onSuccess: () => setDel(null) });
  const clone = useSave({ invalidate: ['roles', 'lookup'] });
  const countGrants = (g: PermissionGrants) => Object.values(g ?? {}).filter((a) => a.length).length;
  const columns: Column<Role>[] = [
    { key: 'name', header: 'Role', locked: true, render: (r) => (<div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-lighter text-primary"><ShieldCheck className="h-4 w-4" /></span><div><div className="font-medium text-gray-900">{r.name}</div>{r.description && <div className="text-[12px] text-gray-500">{r.description}</div>}</div></div>) },
    { key: 'key', header: 'Type', render: (r) => (r.isSystem ? <Badge color="blue">System</Badge> : <Badge>Custom</Badge>) },
    { key: 'permissions', header: 'Permissions', sortable: false, render: (r) => (r.key === 'super_admin' ? <Badge color="purple">All</Badge> : `${countGrants(r.permissions)} modules`) },
    { key: 'userCount', header: 'Users', align: 'right', render: (r) => r.userCount },
    { key: 'isActive', header: 'Status', render: (r) => (r.isActive ? <Badge color="green">Active</Badge> : <Badge color="red">Inactive</Badge>) },
  ];
  return (
    <>
      <h2 className="mb-1 text-[20px] font-semibold text-gray-900">Roles & Permissions</h2>
      <p className="mb-4 text-[13px] text-gray-500">Each user has one role. A role grants read / create / update / delete per module; users can get extra per-user overrides.</p>
      <DataTable storageKey="roles" clientSide hidePagination columns={columns} rows={q.data?.rows ?? []} loading={q.isFetching} state={state} onStateChange={setState} rowKey={(r) => r.id} onRefresh={() => q.refetch()}
        onRowClick={(r) => can('admin_roles', 'update') && setEdit(r)}
        actions={can('admin_roles', 'create') && <button className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Role</button>}
        rowActions={(r) => (
          <span className="inline-flex gap-1">
            <button className="icon-btn h-7 w-7" title="Edit" onClick={() => setEdit(r)}><Pencil className="h-3.5 w-3.5" /></button>
            {can('admin_roles', 'create') && r.key !== 'super_admin' && <button className="icon-btn h-7 w-7" title="Clone" onClick={() => clone.mutate({ method: 'post', url: `/api/admin/roles/${r.id}/clone` })}><Copy className="h-3.5 w-3.5" /></button>}
            {!r.isSystem && can('admin_roles', 'delete') && <button className="icon-btn h-7 w-7 text-red-600" title="Delete" onClick={() => setDel(r)}><Trash2 className="h-3.5 w-3.5" /></button>}
          </span>
        )} />
      <RoleForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} loading={remove.isPending} title="Delete role?" message={<>Delete <b>{del?.name}</b>? Users must be reassigned first.</>} onConfirm={() => del && remove.mutate({ method: 'delete', url: `/api/admin/roles/${del.id}` })} />
    </>
  );
}
