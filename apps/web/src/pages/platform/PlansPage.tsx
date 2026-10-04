import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { PLAN_KINDS, PLAN_KIND_LABELS, planSchema, type PlanKind } from '@erp/shared';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, Dropdown, Field, Modal, Select, Spinner, Switch, TextInput } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { applyPlatformErrors, checkWith, usePlatformSave, usePlans, type Plan } from './queries';

interface PlanValues {
  name: string;
  kind: PlanKind | '';
  durationDays: string;
  price: string;
  isActive: boolean;
  sortOrder: string;
}

type Save = ReturnType<typeof usePlatformSave>;

/** Mounted only while the dialog is open. The kind of a saved plan never changes (the API refuses it). */
function PlanForm({ plan, save }: { plan: Plan | null; save: Save }) {
  const { register, control, handleSubmit, watch, setError, formState: { errors } } = useForm<PlanValues>({
    defaultValues: plan
      ? { name: plan.name, kind: plan.kind, durationDays: plan.durationDays?.toString() ?? '', price: plan.price, isActive: plan.isActive, sortOrder: String(plan.sortOrder) }
      : { name: '', kind: '', durationDays: '', price: '', isActive: true, sortOrder: '0' },
  });
  const kind = watch('kind');
  const submit = handleSubmit((v) => {
    const body = checkWith(planSchema, { ...v, kind: v.kind || undefined, durationDays: v.kind === 'DAYS' || v.durationDays.trim() === '' ? null : v.durationDays }, setError as never);
    if (body) save.mutate({ method: plan ? 'put' : 'post', url: plan ? `/api/platform/plans/${plan.id}` : '/api/platform/plans', body }, { onError: (e) => applyPlatformErrors(e, setError as never) });
  });
  return (
    <form id="platform-plan" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" required error={errors.name?.message} className="sm:col-span-2"><TextInput {...register('name')} placeholder="e.g. Monthly" /></Field>
      <Field label="Kind" required error={errors.kind?.message} hint={plan ? 'A saved plan keeps its kind' : undefined}>
        <Controller control={control} name="kind" render={({ field }) => <Select value={field.value} onChange={field.onChange} disabled={!!plan} placeholder="Choose" options={PLAN_KINDS.map((k) => ({ value: k, label: PLAN_KIND_LABELS[k] }))} />} />
      </Field>
      {kind !== 'DAYS' && (
        <Field label="Duration (days)" required error={errors.durationDays?.message}><TextInput inputMode="numeric" {...register('durationDays')} placeholder={kind === 'YEARLY' ? '365' : kind === 'MONTHLY' ? '30' : '7'} /></Field>
      )}
      <Field label={kind === 'DAYS' ? 'Price per day (₹)' : 'Price (₹)'} required error={errors.price?.message} hint={kind === 'DAYS' ? 'Charged × the days chosen when granting' : undefined}>
        <TextInput inputMode="decimal" {...register('price')} />
      </Field>
      <Field label="Sort order" error={errors.sortOrder?.message}><TextInput inputMode="numeric" {...register('sortOrder')} /></Field>
      <Field label="Status" hint="An inactive plan cannot be granted">
        <div className="flex h-10 items-center"><Controller control={control} name="isActive" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label={field.value ? 'Active' : 'Inactive'} />} /></div>
      </Field>
    </form>
  );
}

function PlanDialog({ plan, open, onClose }: { plan: Plan | null; open: boolean; onClose: () => void }) {
  const save = usePlatformSave({ onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} size="md" title={plan ? `Edit plan — ${plan.name}` : 'New plan'} footer={<><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button type="submit" form="platform-plan" className="btn-primary" disabled={save.isPending}>{save.isPending && <Spinner />} {plan ? 'Update' : 'Save'}</button></>}>
      <PlanForm plan={plan} save={save} />
    </Modal>
  );
}

export default function PlansPage() {
  const q = usePlans();
  const [state, setState] = useListState({ sortBy: 'sortOrder', sortOrder: 'asc' });
  // undefined = closed, null = new plan
  const [edit, setEdit] = useState<Plan | null | undefined>(undefined);
  const [remove, setRemove] = useState<Plan | null>(null);
  const del = usePlatformSave({ onSuccess: () => setRemove(null) });
  const columns: Column<Plan>[] = [
    { key: 'name', header: 'Name', locked: true, render: (p) => <span className="font-medium text-gray-900">{p.name}</span> },
    { key: 'kind', header: 'Kind', render: (p) => PLAN_KIND_LABELS[p.kind] },
    { key: 'durationDays', header: 'Duration', align: 'right', render: (p) => (p.durationDays === null ? 'Chosen when granting' : `${p.durationDays} days`) },
    { key: 'price', header: 'Price', align: 'right', sortValue: (p) => Number(p.price), render: (p) => `${fmtMoney(p.price)}${p.kind === 'DAYS' ? ' / day' : ''}` },
    { key: 'isActive', header: 'Status', render: (p) => (p.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>) },
    { key: 'usedCount', header: 'Granted', align: 'right', render: (p) => (p.usedCount ? `${p.usedCount} time${p.usedCount === 1 ? '' : 's'}` : 'Never') },
    { key: 'sortOrder', header: 'Order', align: 'right' },
  ];
  return (
    <>
      <div className="mb-3">
        <h2 className="text-[20px] font-semibold text-gray-900">Plans</h2>
        <p className="text-[13px] text-gray-500">You decide every plan — its name, type, days and price. Every plan unlocks every feature; a plan only buys time.</p>
      </div>
      {q.isError && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">Could not load the plans. {q.error instanceof Error ? q.error.message : ''}</p>}
      <DataTable
        columns={columns}
        rows={q.data ?? []}
        loading={q.isFetching}
        state={state}
        onStateChange={setState}
        rowKey={(p) => p.id}
        onRowClick={setEdit}
        clientSide
        hidePagination
        hideSearch
        filterFields={false}
        emptyTitle="No plans yet"
        emptyDescription="Create your plans with New plan — e.g. a Trial for new studios, then Monthly / Yearly / Day-wise at your prices."
        onRefresh={() => q.refetch()}
        actions={<button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> New plan</button>}
        rowActions={(p) => (
          <Dropdown
            trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${p.name}`}>…</button>}
            items={[
              { label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(p) },
              // A plan that was ever granted stays — history refers to it; make it inactive instead.
              ...(p.usedCount === 0 ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setRemove(p) }] : []),
            ]}
          />
        )}
        mobileCard={(p) => (
          <div>
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-gray-900">{p.name}</span>{p.isActive ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}</div>
            <div className="text-[12px] text-gray-500">{PLAN_KIND_LABELS[p.kind]} · {p.durationDays === null ? 'days chosen when granting' : `${p.durationDays} days`} · {fmtMoney(p.price)}{p.kind === 'DAYS' ? ' / day' : ''}</div>
          </div>
        )}
      />
      <PlanDialog plan={edit ?? null} open={edit !== undefined} onClose={() => setEdit(undefined)} />
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        onConfirm={() => remove && del.mutate({ method: 'delete', url: `/api/platform/plans/${remove.id}` })}
        title="Delete plan?"
        message={remove ? `"${remove.name}" has never been granted, so it can be deleted.` : undefined}
        loading={del.isPending}
      />
    </>
  );
}
