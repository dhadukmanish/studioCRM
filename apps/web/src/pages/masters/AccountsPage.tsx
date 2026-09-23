import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  ACCOUNT_LIMITS,
  ALL_ACCOUNT_DETAIL_KEYS,
  HEAD_GROUPS,
  OPENING_SIDE_SHORT,
  accountDetailFor,
  accountDetailKeys,
  type AccountOpeningSide,
  type FilterFieldDef,
  type HeadGroup,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, Combobox, ConfirmDialog, Dropdown, Field, Modal, Select, Spinner, Switch, TextArea, TextInput, type Option } from '@/components/ui';
import { api } from '@/lib/api';
import { applyApiErrors, useAccountGroupsLookup, useItemsLookup, useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtDate, fmtMoney } from '@/lib/format';

const PERMISSION = 'masters_accounts';
const URL = '/api/masters/accounts';
const QUERY_KEY = 'accounts';
/** The edit form loads the full record (common fields + detail block) under this key. */
const RECORD_KEY = 'account';

/** A list row — the detail block is deliberately absent, it belongs to the form, not the table. */
interface Account {
  id: string;
  accountGroupId: string;
  accountName: string;
  /** joined from Account Group by the list endpoint — never a second copy in the accounts table */
  groupName: string;
  headGroup: HeadGroup;
  openingAmount: number;
  openingSide: AccountOpeningSide;
  remark: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What GET /:id adds: whichever detail block the account's group drives. */
interface AccountRecord extends Account {
  detail: (Record<string, string | number | null> & { itemName?: string | null }) | null;
}

const sideOptions = [
  { value: 'DEBIT', label: 'Debit (Dr)' },
  { value: 'CREDIT', label: 'Credit (Cr)' },
];
const statusOptions = [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }];
const headGroupOptions = HEAD_GROUPS.map((h) => ({ value: h, label: h }));

/** "₹52,723.00 Dr" — the amount is always positive; the side says which way it leans. */
const fmtOpening = (amount: number, side: AccountOpeningSide) => `${fmtMoney(amount)} ${OPENING_SIDE_SHORT[side] ?? ''}`.trim();

/* ------------------------------------------------------------------ form -- */

/** Every detail field of every block lives in the form; only the active block is rendered and sent. */
type DetailValues = Record<string, string>;
interface FormValues {
  accountGroupId: string;
  accountName: string;
  openingAmount: string;
  openingSide: AccountOpeningSide;
  remark: string;
  isActive: boolean;
  detail: DetailValues;
}

const emptyDetail = (): DetailValues => Object.fromEntries(ALL_ACCOUNT_DETAIL_KEYS.map((k) => [k, '']));
const emptyForm = (): FormValues => ({ accountGroupId: '', accountName: '', openingAmount: '', openingSide: 'DEBIT', remark: '', isActive: true, detail: emptyDetail() });
const toForm = (row: Account, detail: AccountRecord['detail']): FormValues => ({
  accountGroupId: row.accountGroupId,
  accountName: row.accountName,
  openingAmount: String(row.openingAmount ?? ''),
  openingSide: row.openingSide,
  remark: row.remark ?? '',
  isActive: row.isActive,
  detail: { ...emptyDetail(), ...Object.fromEntries(Object.entries(detail ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])) },
});

/** A titled block of fields. Spacing and a thin rule, not a card — the form stays one surface. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="section-title border-b border-line pb-2">{title}</h4>
      <div className="mt-4 grid gap-x-5 gap-y-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function AccountForm({ open, onClose, row }: { open: boolean; onClose: () => void; row?: Account | null }) {
  const { register, handleSubmit, control, reset, setValue, getValues, setError, clearErrors, watch, formState: { errors } } = useForm<FormValues>({ defaultValues: emptyForm() });
  const groups = useAccountGroupsLookup();
  const items = useItemsLookup();
  /** Pending group change awaiting confirmation, because accepting it would discard entered detail. */
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);

  /**
   * The group's NAME decides which block shows — never its head group. BANK is filed under
   * ASSETS, but that must not give every ASSETS group a bank account number.
   */
  const groupNameOf = useCallback(
    (id: string) => (id === row?.accountGroupId ? row.groupName : undefined) ?? groups.data?.find((g) => g.id === id)?.groupName,
    [groups.data, row],
  );
  const selectedGroupId = watch('accountGroupId');
  const section = accountDetailFor(groupNameOf(selectedGroupId));

  /**
   * An account whose group already has a detail block needs the full record; one that has none
   * is fully described by the list row, so editing it opens instantly with no extra request.
   */
  const needsRecord = open && !!row && !!accountDetailFor(row.groupName);
  const record = useQuery({
    queryKey: [RECORD_KEY, row?.id],
    queryFn: () => api.get<AccountRecord>(`${URL}/${row!.id}`),
    enabled: needsRecord,
  });
  const loadingRecord = needsRecord && !record.data;

  useEffect(() => {
    if (!open) return;
    setPendingGroupId(null);
    if (!row) { reset(emptyForm()); return; }
    if (!needsRecord) { reset(toForm(row, null)); return; }
    if (record.data) reset(toForm(record.data, record.data.detail));
  }, [open, row, needsRecord, record.data, reset]);

  /** The picker offers active groups; an account already filed under a deactivated one keeps it. */
  const groupOptions: Option[] = useMemo(() => {
    const opts = (groups.data ?? []).map((g) => ({ value: g.id, label: g.groupName, sub: g.headGroup }));
    if (!row?.accountGroupId || opts.some((o) => o.value === row.accountGroupId)) return opts;
    return [{ value: row.accountGroupId, label: row.groupName, sub: '(inactive)' }, ...opts];
  }, [groups.data, row]);

  /** Same rule for the item a CLIENT/PARTY references — a deactivated item must stay visible. */
  const itemOptions: Option[] = useMemo(() => {
    const opts = (items.data ?? []).map((i) => ({ value: i.id, label: i.itemName }));
    const current = record.data?.detail?.itemId;
    if (typeof current !== 'string' || opts.some((o) => o.value === current)) return opts;
    return [{ value: current, label: (record.data?.detail?.itemName as string) ?? 'Unknown item', sub: '(inactive)' }, ...opts];
  }, [items.data, record.data]);

  const applyGroup = (next: string) => {
    setValue('accountGroupId', next, { shouldDirty: true });
    // Stale detail must not survive the switch, and must not be submitted either — the form
    // only sends the active block's fields, and the API ignores anything else regardless.
    setValue('detail', emptyDetail());
    clearErrors('detail');
  };

  const changeGroup = (next: string) => {
    const current = getValues('accountGroupId');
    if (next === current) return;
    const from = accountDetailFor(groupNameOf(current))?.kind ?? null;
    const to = accountDetailFor(groupNameOf(next))?.kind ?? null;
    // Same block either side (including none either side, and CLIENT <-> EXPOSER/PARTY, which
    // share their fields) — nothing is discarded, so nothing needs confirming.
    if (from === to) { setValue('accountGroupId', next, { shouldDirty: true }); return; }
    const entered = from ? accountDetailKeys(from).some((k) => String(getValues(`detail.${k}` as const) ?? '').trim() !== '') : false;
    // Editing a saved account is the only case where real data is at stake.
    if (row && entered) { setPendingGroupId(next); return; }
    applyGroup(next);
  };

  const save = useSave({ invalidate: [QUERY_KEY, RECORD_KEY], onSuccess: onClose });
  const submit = handleSubmit((v) => {
    const kind = section?.kind;
    save.mutate(
      {
        method: row ? 'put' : 'post',
        url: row ? `${URL}/${row.id}` : URL,
        body: {
          accountGroupId: v.accountGroupId,
          accountName: v.accountName,
          openingAmount: v.openingAmount,
          openingSide: v.openingSide,
          remark: v.remark,
          isActive: v.isActive,
          // exactly the active block's fields, never the whole form state
          detail: kind ? Object.fromEntries(accountDetailKeys(kind).map((k) => [k, v.detail[k] ?? ''])) : undefined,
        },
      },
      { onError: (e) => applyApiErrors(e, setError as never) },
    );
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

  const detailError = (key: string) => (errors.detail as Record<string, { message?: string }> | undefined)?.[key]?.message;
  const text = (key: string, max: number = ACCOUNT_LIMITS.text) => ({ maxLength: max, ...register(`detail.${key}` as const, { setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim() : v) }) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      maxHeight="max-h-[88vh]"
      title={row ? 'Edit Account' : 'Add Account'}
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={submit} disabled={save.isPending || loadingRecord}>
            {save.isPending && <Spinner />} {row ? 'Update Account' : 'Save Account'}
          </button>
        </>
      }
    >
      {loadingRecord ? (
        <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-primary" /></div>
      ) : (
        <form onSubmit={submit} className="space-y-7">
          <Section title="Account Details">
            <Field label="Account Group" required error={errors.accountGroupId?.message} hint="The group decides which extra details this account needs.">
              <Controller
                control={control}
                name="accountGroupId"
                rules={{ required: 'Account group is required' }}
                render={({ field }) => <Combobox value={field.value} onChange={changeGroup} options={groupOptions} placeholder="Select account group" clearable={false} />}
              />
            </Field>
            <Field label="Account Name" required error={errors.accountName?.message}>
              <TextInput placeholder="Enter account name" maxLength={ACCOUNT_LIMITS.accountName} {...register('accountName', { required: 'Account name is required', setValueAs: (v) => (typeof v === 'string' ? v.trim() : v) })} />
            </Field>
            <Field label="Opening Amount (₹)" error={errors.openingAmount?.message} hint="Leave blank for no opening balance.">
              <TextInput inputMode="decimal" placeholder="0.00" {...register('openingAmount')} />
            </Field>
            <Field label="Dr / Cr" error={errors.openingSide?.message} hint="A credit opening balance is a side, never a negative amount.">
              <Controller control={control} name="openingSide" render={({ field }) => <Select value={field.value} onChange={field.onChange} options={sideOptions} placeholder="Select side" />} />
            </Field>
            <Field label={<>Remark <span className="font-normal text-gray-500">(Optional)</span></>} error={errors.remark?.message}>
              <TextArea rows={2} placeholder="Enter remark (optional)" maxLength={ACCOUNT_LIMITS.remark} {...register('remark')} />
            </Field>
            <Field label="Status">
              <div className="flex h-10 items-center">
                <Controller control={control} name="isActive" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label={field.value ? 'Active' : 'Inactive'} />} />
              </div>
            </Field>
          </Section>

          {pendingGroupId && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-[13px] text-amber-800">
                Changing the account group will clear {accountDetailFor(groupNameOf(getValues('accountGroupId')))?.title ?? 'the current details'}. Continue?
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button type="button" className="btn-outline" onClick={() => setPendingGroupId(null)}>Keep current group</button>
                <button type="button" className="btn-primary" autoFocus onClick={() => { applyGroup(pendingGroupId); setPendingGroupId(null); }}>Continue</button>
              </div>
            </div>
          )}

          {/* Only the block this group drives is rendered — never every field the master can hold. */}
          {section?.kind === 'bank' && (
            <Section title={section.title}>
              <Field label="Our Bank Name" error={detailError('bankName')}><TextInput placeholder="Enter bank name" {...text('bankName')} /></Field>
              <Field label="Account Type" error={detailError('accountType')}><TextInput placeholder="E.g. Savings, Current" {...text('accountType')} /></Field>
              <Field label="Branch" error={detailError('branch')}><TextInput placeholder="Enter branch" {...text('branch')} /></Field>
              <Field label="Account Number" error={detailError('accountNumber')}><TextInput placeholder="Enter account number" {...text('accountNumber', ACCOUNT_LIMITS.accountNumber)} /></Field>
            </Section>
          )}

          {section?.kind === 'employee' && (
            <Section title={section.title}>
              <Field label="Employee Name" error={detailError('employeeName')}><TextInput placeholder="Enter employee name" {...text('employeeName')} /></Field>
              <Field label="Contact Number" error={detailError('contactNumber')}><TextInput placeholder="Enter contact number" {...text('contactNumber', ACCOUNT_LIMITS.contact)} /></Field>
              <Field label="Address" error={detailError('address')}><TextInput placeholder="Enter address" {...text('address', ACCOUNT_LIMITS.address)} /></Field>
              <Field label="Designation" error={detailError('designation')}><TextInput placeholder="Enter designation" {...text('designation')} /></Field>
              <Field label="Salary Type" error={detailError('salaryType')}><TextInput placeholder="E.g. Monthly, Daily" {...text('salaryType')} /></Field>
              <Field label="Salary (₹)" error={detailError('salary')}><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.salary')} /></Field>
              <Field label="Commission" error={detailError('commission')} hint="Recorded only — nothing is calculated from it yet."><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.commission')} /></Field>
            </Section>
          )}

          {section?.kind === 'loan' && (
            <Section title={section.title}>
              <Field label="Interest Rate %" error={detailError('interestRate')} hint="Recorded only — no interest is calculated yet."><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.interestRate')} /></Field>
            </Section>
          )}

          {section?.kind === 'partner' && (
            <Section title={section.title}>
              <Field label="Mobile Number" className="sm:col-span-2" error={detailError('mobileNumber')}><TextInput placeholder="Enter mobile number" {...text('mobileNumber', ACCOUNT_LIMITS.contact)} /></Field>
              <Field label="Profit %" error={detailError('profitPercent')}><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.profitPercent')} /></Field>
              <Field label="Loss %" error={detailError('lossPercent')}><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.lossPercent')} /></Field>
            </Section>
          )}

          {section?.kind === 'party' && (
            <Section title={section.title}>
              <Field label="Name" error={detailError('partyName')}><TextInput placeholder="Enter name" {...text('partyName')} /></Field>
              <Field label="Contact Number" error={detailError('contactNumber')}><TextInput placeholder="Enter contact number" {...text('contactNumber', ACCOUNT_LIMITS.contact)} /></Field>
              <Field label="Address" error={detailError('address')}><TextInput placeholder="Enter address" {...text('address', ACCOUNT_LIMITS.address)} /></Field>
              <Field label="Email Id" error={detailError('email')}><TextInput type="email" placeholder="name@example.com" {...text('email', ACCOUNT_LIMITS.email)} /></Field>
              <Field label="GST" error={detailError('gst')}><TextInput placeholder="Enter GST number" {...text('gst', ACCOUNT_LIMITS.gst)} /></Field>
              <Field label="PAN No" error={detailError('panNo')}><TextInput placeholder="Enter PAN number" {...text('panNo', ACCOUNT_LIMITS.pan)} /></Field>
              <Field label="Item Name" error={detailError('itemId')} hint="An Item Master row — sub items are not selected here.">
                <Controller control={control} name="detail.itemId" render={({ field }) => <Combobox value={field.value} onChange={field.onChange} options={itemOptions} placeholder="Select item" />} />
              </Field>
              <Field label="Rate (₹)" error={detailError('rate')}><TextInput inputMode="decimal" placeholder="0.00" {...register('detail.rate')} /></Field>
            </Section>
          )}

          {/* lets Enter submit from any field while the real buttons live in the modal footer */}
          <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">Save</button>
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function AccountsPage() {
  const [state, setState] = useListState({ sortBy: 'updatedAt', sortOrder: 'desc' });
  const [accountGroupId, setAccountGroupId] = useState('');
  const [status, setStatus] = useState('');
  const q = useList<Account>(QUERY_KEY, URL, state, { accountGroupId, isActive: status });
  const groups = useAccountGroupsLookup();
  const [edit, setEdit] = useState<Account | null | undefined>(undefined);
  const [del, setDel] = useState<Account | null>(null);
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY, RECORD_KEY], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!accountGroupId || !!status || !!state.search || state.filters.length > 0;
  const groupOptions: Option[] = useMemo(() => (groups.data ?? []).map((g) => ({ value: g.id, label: g.groupName, sub: g.headGroup })), [groups.data]);

  const filterFields: FilterFieldDef[] = [
    { key: 'accountName', label: 'Account Name' },
    { key: 'groupName', label: 'Group' },
    { key: 'headGroup', label: 'Type (Head Group)', type: 'select', options: headGroupOptions },
    { key: 'openingAmount', label: 'Opening Amount', type: 'number' },
    { key: 'openingSide', label: 'Dr / Cr', type: 'select', options: sideOptions },
    { key: 'remark', label: 'Remark' },
    { key: 'isActive', label: 'Active', type: 'boolean' },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const columns: Column<Account>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'accountName', header: 'Account Name', render: (r) => <span className="font-medium text-gray-900">{r.accountName}</span> },
    { key: 'groupName', header: 'Group' },
    { key: 'headGroup', header: 'Type' },
    { key: 'openingAmount', header: 'Opening Balance', render: (r) => fmtOpening(r.openingAmount, r.openingSide) },
    { key: 'isActive', header: 'Status', render: (r) => <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmtDate(r.updatedAt) },
    { key: 'remark', header: 'Remark', hidden: true, render: (r) => <span className="text-gray-600">{r.remark || '-'}</span> },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmtDate(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Masters' }, { label: 'Account Master' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Account Master</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'account' : 'accounts'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => setEdit(null)}><Plus className="h-4 w-4" /> Add Account</button>
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
        searchPlaceholder="Search by account name, group..."
        onRowClick={(r) => canEdit && setEdit(r)}
        toolbar={
          <>
            {/* both quick filters live outside useListState, so each one resets the page itself */}
            <Combobox size="sm" className="w-[180px]" value={accountGroupId} onChange={(v) => { setAccountGroupId(v); setState({ page: 1 }); }} placeholder="All Groups" options={groupOptions} />
            <Select size="sm" className="w-[140px]" value={status} onChange={(v) => { setStatus(v); setState({ page: 1 }); }} placeholder="All Status" options={statusOptions} />
            {filtered && (
              <button type="button" className="btn-ghost text-primary" onClick={() => { setAccountGroupId(''); setStatus(''); setState({ search: '', filters: [], page: 1 }); }}>Clear</button>
            )}
          </>
        }
        emptyTitle={filtered ? 'No matching accounts' : 'No accounts yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Add the accounts this studio keeps under each account group.'}
        rowActions={(r) =>
          canEdit || canDelete ? (
            <Dropdown
              trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for ${r.accountName}`}>…</button>}
              items={[
                ...(canEdit ? [{ label: 'Edit', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setEdit(r) }] : []),
                ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
              ]}
            />
          ) : null
        }
      />

      <AccountForm open={edit !== undefined} onClose={() => setEdit(undefined)} row={edit} />
      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete account?"
        message={<>Delete <b>"{del?.accountName}"</b>? This cannot be undone. To keep it for existing records, set it to Inactive instead.</>}
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
