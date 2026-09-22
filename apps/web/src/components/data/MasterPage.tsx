import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Combobox, ConfirmDialog, Field, Modal, Select, Spinner, Switch, TextArea, TextInput, type Option } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { applyApiErrors, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import type { FilterFieldDef } from '@erp/shared';

/** Declarative field for the generated form. */
export interface MasterField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'textarea' | 'select' | 'combobox' | 'multi' | 'switch' | 'custom';
  required?: boolean;
  options?: Option[] | (() => Option[]);
  placeholder?: string;
  hint?: string;
  span?: 1 | 2;
  /** hide when predicate returns false (receives current form values) */
  visible?: (values: any) => boolean;
  disabled?: (values: any, row?: any) => boolean;
  render?: (form: UseFormReturn<any>, row?: any) => ReactNode;
}

export interface MasterConfig<T = any> {
  title: string;
  label: string; // singular
  url: string;
  permission: string;
  queryKey: string;
  columns: Column<T>[];
  fields: MasterField[];
  defaults: Record<string, any>;
  /** map API row → form values */
  toForm?: (row: T) => Record<string, any>;
  /** map form values → API body */
  toBody?: (values: Record<string, any>, row?: T) => Record<string, any>;
  canDelete?: (row: T) => boolean;
  canEdit?: (row: T) => boolean;
  toolbar?: ReactNode;
  extraActions?: ReactNode;
  filters?: Record<string, unknown>;
  modalSize?: 'sm' | 'md' | 'lg' | 'xl';
  emptyDescription?: ReactNode;
  /** invalidate these extra query keys after save */
  invalidate?: string[];
  storageKey?: string;
  hideSearch?: boolean;
  /** filter builder fields (defaults to all columns as text) */
  filterFields?: FilterFieldDef[] | false;
  /** rows shown from a static/derived list instead of fetching */
  rowFilter?: (rows: T[]) => T[];
}

const plural = (s: string) => (/(s|x|ch|sh)$/.test(s) ? s : s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's');

export function useMasterList<T = any>(cfg: MasterConfig<T>, state: ReturnType<typeof useListState>[0]) {
  return useQuery({
    queryKey: [cfg.queryKey, state.search, cfg.filters],
    queryFn: () => api.get<{ rows: T[]; total: number }>(`${cfg.url}${qs({ search: state.search, limit: 500, sortOrder: 'asc', ...(cfg.filters ?? {}) })}`),
    placeholderData: (p) => p,
  });
}

export function MasterForm({ cfg, open, onClose, row }: { cfg: MasterConfig; open: boolean; onClose: () => void; row?: any | null }) {
  const form = useForm<any>({ defaultValues: cfg.defaults });
  const { register, handleSubmit, control, reset, watch, setError, formState: { errors } } = form;
  useEffect(() => { if (open) reset(row ? { ...cfg.defaults, ...(cfg.toForm ? cfg.toForm(row) : row) } : cfg.defaults); }, [open, row]); // eslint-disable-line
  const values = watch();
  const save = useSave({ invalidate: [cfg.queryKey, 'lookup-masters', ...(cfg.invalidate ?? [])], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    const body = cfg.toBody ? cfg.toBody(v, row) : v;
    save.mutate({ method: row ? 'put' : 'post', url: row ? `${cfg.url}/${row.id}` : cfg.url, body }, { onError: (e) => applyApiErrors(e, setError as any) });
  });
  const opts = (f: MasterField) => (typeof f.options === 'function' ? f.options() : f.options) ?? [];
  return (
    <Modal open={open} onClose={onClose} size={cfg.modalSize ?? 'md'} title={row ? `Edit ${cfg.label}` : `Add ${cfg.label}`} footer={<><button className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit} disabled={save.isPending}>{save.isPending && <Spinner />} {row ? 'Update' : 'Save'}</button></>}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {cfg.fields.map((f) => {
          if (f.visible && !f.visible(values)) return null;
          const err = (errors as any)[f.name]?.message as string | undefined;
          const dis = f.disabled?.(values, row);
          const cls = f.span === 2 ? 'sm:col-span-2' : undefined;
          const rules = f.required ? { required: `${f.label} is required` } : undefined;
          switch (f.type) {
            case 'custom':
              return <div key={f.name} className={cls}>{f.render?.(form, row)}</div>;
            case 'textarea':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls ?? 'sm:col-span-2'}><TextArea {...register(f.name, rules)} placeholder={f.placeholder} disabled={dis} /></Field>;
            case 'select':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><Controller control={control} name={f.name} rules={rules} render={({ field }) => <Select value={field.value} onChange={field.onChange} options={opts(f)} placeholder={f.placeholder} disabled={dis} />} /></Field>;
            case 'combobox':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><Controller control={control} name={f.name} rules={rules} render={({ field }) => <Combobox value={field.value} onChange={field.onChange} options={opts(f)} placeholder={f.placeholder} disabled={dis} />} /></Field>;
            case 'multi':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><Controller control={control} name={f.name} rules={rules} render={({ field }) => <Combobox multiple value={field.value} onChange={field.onChange} options={opts(f)} placeholder={f.placeholder} disabled={dis} />} /></Field>;
            case 'switch':
              return <div key={f.name} className={cls ?? 'flex items-end pb-2'}><Controller control={control} name={f.name} render={({ field }) => <Switch checked={!!field.value} onChange={field.onChange} label={f.label} disabled={dis} />} />{f.hint && <span className="ml-2 text-[12px] text-gray-500">{f.hint}</span>}</div>;
            case 'number':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><TextInput type="number" step="any" {...register(f.name, rules)} placeholder={f.placeholder} disabled={dis} /></Field>;
            case 'date':
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><TextInput type="date" {...register(f.name, rules)} disabled={dis} /></Field>;
            default:
              return <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={cls}><TextInput {...register(f.name, rules)} placeholder={f.placeholder} disabled={dis} /></Field>;
          }
        })}
      </form>
    </Modal>
  );
}

export function MasterPage({ cfg, children }: { cfg: MasterConfig; children?: ReactNode }) {
  const [state, setState] = useListState({ limit: 500, sortOrder: 'asc' });
  const q = useMasterList(cfg, state);
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const [del, setDel] = useState<any | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [cfg.queryKey, 'lookup-masters', ...(cfg.invalidate ?? [])], onSuccess: () => setDel(null) });
  const rows = useMemo(() => (cfg.rowFilter ? cfg.rowFilter(q.data?.rows ?? []) : q.data?.rows ?? []), [q.data, cfg]);
  return (
    <>
      <h2 className="mb-4 text-[20px] font-semibold text-gray-900">{cfg.title}</h2>
      {children}
      <DataTable storageKey={cfg.storageKey ?? cfg.queryKey} columns={cfg.columns} rows={rows} loading={q.isFetching} state={state} onStateChange={setState} rowKey={(r: any) => r.id} onRefresh={() => q.refetch()} hidePagination hideSearch={cfg.hideSearch} clientSide filterFields={cfg.filterFields}
        toolbar={cfg.toolbar}
        onRowClick={(r: any) => can(cfg.permission, 'update') && (cfg.canEdit?.(r) ?? true) && setEdit(r)}
        actions={<>{cfg.extraActions}{can(cfg.permission, 'create') && <button className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add {cfg.label}</button>}</>}
        rowActions={(r: any) => (
          <span className="inline-flex gap-1">
            {(cfg.canEdit?.(r) ?? true) && can(cfg.permission, 'update') && <button className="icon-btn h-7 w-7" onClick={() => setEdit(r)}><Pencil className="h-3.5 w-3.5" /></button>}
            {(cfg.canDelete?.(r) ?? true) && can(cfg.permission, 'delete') && <button className="icon-btn h-7 w-7 text-red-600" onClick={() => setDel(r)}><Trash2 className="h-3.5 w-3.5" /></button>}
          </span>
        )}
        emptyTitle={`No ${plural(cfg.label.toLowerCase())} yet`} emptyDescription={cfg.emptyDescription} />
      <MasterForm cfg={cfg} open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} loading={remove.isPending} title={`Delete ${cfg.label.toLowerCase()}?`} message={<>Delete <b>{del?.name ?? del?.labName ?? ''}</b>?</>} onConfirm={() => del && remove.mutate({ method: 'delete', url: `${cfg.url}/${del.id}` })} />
    </>
  );
}
