import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { FilterFieldDef } from '@erp/shared';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { CustomFieldInputs } from '@/components/data/CustomFieldInputs';
import { Badge, Combobox, ConfirmDialog, Field, Modal, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { applyApiErrors, useBranches, useCompanies, useList, useRoles, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtDate } from '@/lib/format';

/**
 * A user has exactly one role, and the role carries the permissions. Per-user permission
 * overrides are not configurable — see docs/ARCHITECTURE.md ("Permission model").
 */
const defaults = { firstName: '', lastName: '', email: '', username: '', mobile: '', password: '', roleId: '', companyIds: [] as string[], branchIds: [] as string[], isActive: true, customFields: {} as Record<string, any> };

function UserForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: any | null }) {
  const companies = useCompanies();
  const branches = useBranches();
  const roles = useRoles();
  const { register, handleSubmit, control, reset, watch, setError, formState: { errors } } = useForm<typeof defaults>({ defaultValues: defaults });
  useEffect(() => {
    if (!open) return;
    // Only the fields this form owns — the row also carries id, tenantId and the retired
    // permissionOverrides, none of which belong in the payload.
    reset(row
      ? { firstName: row.firstName, lastName: row.lastName, email: row.email, username: row.username ?? '', mobile: row.mobile ?? '', password: '', roleId: row.roleId, companyIds: row.companyIds ?? [], branchIds: row.branchIds ?? [], isActive: row.isActive, customFields: row.customFields ?? {} }
      : { ...defaults, roleId: roles.data?.find((r) => r.key === 'user')?.id ?? '' });
  }, [open, row, reset]); // eslint-disable-line
  /** Rows written before roles became the only source may still carry extra grants. */
  const legacyGrants = Object.values((row?.permissionOverrides ?? {}) as Record<string, string[]>).some((a) => a?.length);
  const companyIds = watch('companyIds');
  const save = useSave({ invalidate: ['users', 'lookup'], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    const body: any = { ...v, username: v.username || null, mobile: v.mobile || null };
    if (!body.password) delete body.password;
    save.mutate({ method: row ? 'put' : 'post', url: row ? `/api/admin/users/${row.id}` : '/api/admin/users', body }, { onError: (e) => applyApiErrors(e, setError as any) });
  });
  const branchOpts = (branches.data ?? []).filter((b) => !companyIds.length || companyIds.includes(b.companyId)).map((b) => ({ value: b.id, label: b.name, sub: companies.data?.find((c) => c.id === b.companyId)?.name }));
  return (
    <Modal open={open} onClose={onClose} title={row ? `Edit User — ${row.name}` : 'Add User'} size="lg" footer={<><button className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending && <Spinner />} {row ? 'Update' : 'Save'}</button></>}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="First Name" required error={errors.firstName?.message}><TextInput {...register('firstName', { required: 'Required' })} /></Field>
        <Field label="Last Name" required error={errors.lastName?.message}><TextInput {...register('lastName', { required: 'Required' })} /></Field>
        <Field label="Email" required error={errors.email?.message}><TextInput type="email" {...register('email', { required: 'Required' })} /></Field>
        <Field label="Username" hint="Optional — can also be used to sign in"><TextInput {...register('username')} /></Field>
        <Field label="Mobile"><TextInput {...register('mobile')} /></Field>
        <Field label={row ? 'New Password' : 'Password'} required={!row} error={errors.password?.message} hint={row ? 'Leave blank to keep current password' : 'Minimum 6 characters'}><TextInput type="password" autoComplete="new-password" {...register('password', { required: row ? false : 'Required', minLength: { value: 6, message: 'Minimum 6 characters' } })} /></Field>
        <Field label="Role" required error={errors.roleId?.message} hint="Permissions come from this role">
          <Controller control={control} name="roleId" rules={{ required: 'Role is required' }} render={({ field }) => <Select value={field.value} onChange={field.onChange} options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} />} />
        </Field>
        <Field label="Status"><div className="flex h-10 items-center"><Controller control={control} name="isActive" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label={field.value ? 'Active' : 'Inactive'} />} /></div></Field>

        {legacyGrants && (
          <p className="sm:col-span-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            This user also carries extra permissions granted before roles became the only source. They still apply, but can no longer be changed here — ask a developer to clear them.
          </p>
        )}

        <div className="sm:col-span-2 border-t border-line pt-4 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Data access</div>
        <Field label="Companies" hint="Leave empty for all companies"><Controller control={control} name="companyIds" render={({ field }) => <Combobox multiple value={field.value} onChange={field.onChange} options={(companies.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />} /></Field>
        <Field label="Branches" hint="Leave empty for all branches"><Controller control={control} name="branchIds" render={({ field }) => <Combobox multiple value={field.value} onChange={field.onChange} options={branchOpts} />} /></Field>

        <div className="sm:col-span-2"><Controller control={control} name="customFields" render={({ field }) => <CustomFieldInputs moduleName="users" value={field.value} onChange={field.onChange} />} /></div>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const [state, setState] = useListState();
  const [status, setStatus] = useState('');
  const [roleId, setRoleId] = useState('');
  const roles = useRoles();
  const q = useList<any>('users', '/api/admin/users', state, { isActive: status, roleId });
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const [del, setDel] = useState<any | null>(null);
  const { can, user: me } = useAuthStore();
  const remove = useSave({ invalidate: ['users', 'lookup'], onSuccess: () => setDel(null) });
  const filterFields: FilterFieldDef[] = [
    { key: 'firstName', label: 'First Name' }, { key: 'lastName', label: 'Last Name' }, { key: 'email', label: 'Email' }, { key: 'username', label: 'Username' }, { key: 'mobile', label: 'Mobile' },
    { key: 'roleName', label: 'Role', type: 'select', options: (roles.data ?? []).map((r) => ({ value: r.name, label: r.name })) },
    { key: 'isActive', label: 'Active', type: 'boolean' }, { key: 'lastLoginAt', label: 'Last Login', type: 'date' }, { key: 'createdAt', label: 'Created At', type: 'date' },
  ];
  const columns: Column<any>[] = [
    { key: 'firstName', header: 'Name', locked: true, render: (r) => (<div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-lighter text-[12px] font-semibold text-primary-dark">{(r.firstName?.[0] ?? '') + (r.lastName?.[0] ?? '')}</span><div><div className="font-medium text-gray-900">{r.name}</div><div className="text-[12px] text-gray-500">{r.email}</div></div></div>) },
    { key: 'username', header: 'Username', render: (r) => r.username || '-' },
    { key: 'mobile', header: 'Mobile', render: (r) => r.mobile || '-' },
    { key: 'roleName', header: 'Role', render: (r) => <Badge color={r.roleKey === 'super_admin' ? 'purple' : r.roleKey === 'admin' ? 'blue' : 'gray'}>{r.roleName}</Badge> },
    { key: 'lastLoginAt', header: 'Last Login', render: (r) => fmtDate(r.lastLoginAt, true) },
    { key: 'isActive', header: 'Status', render: (r) => (r.isActive ? <Badge color="green">Active</Badge> : <Badge color="red">Inactive</Badge>) },
    { key: 'email', header: 'Email', hidden: true },
    { key: 'createdAt', header: 'Created At', render: (r) => fmtDate(r.createdAt, true), hidden: true },
  ];
  return (
    <>
      <h2 className="mb-1 text-[20px] font-semibold text-gray-900">Users</h2>
      <p className="mb-4 text-[13px] text-gray-500">Each user has one role, and that role decides what they can do.</p>
      <DataTable storageKey="users" filterFields={filterFields} columns={columns} rows={q.data?.rows ?? []} total={q.data?.total} loading={q.isFetching} state={state} onStateChange={setState} rowKey={(r) => r.id} onRefresh={() => q.refetch()}
        toolbar={<><Select size="sm" className="w-[160px]" value={roleId} onChange={setRoleId} placeholder="All Roles" options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))} /><Select size="sm" className="w-[140px]" value={status} onChange={setStatus} placeholder="All Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} /></>}
        onRowClick={(r) => can('admin_users', 'update') && setEdit(r)}
        actions={can('admin_users', 'create') && <button className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add User</button>}
        rowActions={(r) => (
          <span className="inline-flex gap-1">
            {can('admin_users', 'update') && <button className="row-action" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => setEdit(r)}><Pencil className="h-3.5 w-3.5" /></button>}
            {r.id !== me?.id && can('admin_users', 'delete') && <button className="row-action-danger" title="Delete" aria-label={`Delete ${r.name}`} onClick={() => setDel(r)}><Trash2 className="h-3.5 w-3.5" /></button>}
          </span>
        )} />
      <UserForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} loading={remove.isPending} title="Delete user?" message={<>Delete <b>{del?.name}</b>?</>} onConfirm={() => del && remove.mutate({ method: 'delete', url: `/api/admin/users/${del.id}` })} />
    </>
  );
}
