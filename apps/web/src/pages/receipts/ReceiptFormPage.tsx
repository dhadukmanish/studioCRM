import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, RECEIPT_LIMITS, fromPaise, toPaise, type PaymentMode, type ReceiptRecord, type ReceivableCustomer } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DateInput, EmptyState, Field, Select, Spinner, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useSave } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';
import { cx, fmtMoney, todayISO } from '@/lib/format';
import { RECEIPT_INVALIDATES, RECEIPTS_URL, usePaymentAccounts, usePendingBills, useReceivableCustomer } from '@/lib/receipts';
import { useAuthStore } from '@/store/auth';
import { CustomerPicker } from './CustomerPicker';
import { PendingBillsAllocation } from './PendingBillsAllocation';
import { allocatedPaise, allocationError, paiseText, typedPaise, type Allocations } from './allocation';

const PERMISSION = 'operations_receipts';
const LIST = '/modules/receipts';

/**
 * A new receipt — customer first: pick who paid, see what they owe oldest first, put the money
 * against bills, and save. The receipt amount is never typed; it IS the sum of the allocations,
 * so no money can be left floating. The number, the customer's name and each bill's outstanding
 * are the server's — it re-reads all of them under lock when this is saved.
 *
 * Receipts are never edited, so this page only ever creates one.
 */
export default function ReceiptFormPage() {
  const can = useAuthStore((s) => s.can);
  const nav = useNavigate();
  if (!can(PERMISSION, 'create')) {
    return (
      <EmptyState
        title="You don’t have permission to create receipts"
        action={<button type="button" className="btn-outline" onClick={() => nav(LIST)}>Back to receipts</button>}
      />
    );
  }
  return <ReceiptForm />;
}

type HeaderErrors = Partial<Record<'receiptDate' | 'customerMobile' | 'accountId' | 'remark' | 'amount' | 'allocations', string>>;

function ReceiptForm() {
  const nav = useNavigate();
  const { date: fmtDate } = useDateFormatters();
  const [params] = useSearchParams();
  const presetKey = params.get('customer');
  const presetBill = params.get('bill');

  const [receiptDate, setReceiptDate] = useState(todayISO());
  const [customer, setCustomer] = useState<ReceivableCustomer | null>(null);
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [accountId, setAccountId] = useState('');
  const [remark, setRemark] = useState('');
  const [allocations, setAllocations] = useState<Allocations>({});
  const [errors, setErrors] = useState<HeaderErrors>({});
  const [billErrors, setBillErrors] = useState<Record<string, string>>({});
  const [presetNote, setPresetNote] = useState<string | null>(null);

  /* ---- ?customer=<key>&bill=<id>: preselect the customer, prefill that bill ---- */
  const preset = useReceivableCustomer(presetKey);
  const presetApplied = useRef(false);
  useEffect(() => {
    if (presetApplied.current || !preset.data) return;
    presetApplied.current = true;
    if (preset.data[0]) setCustomer(preset.data[0]);
    else setPresetNote('That customer could not be found. Search for the customer below.');
  }, [preset.data]);

  const pending = usePendingBills(customer?.customerKey);
  const bills = useMemo(() => pending.data ?? [], [pending.data]);
  const billPrefilled = useRef(false);
  useEffect(() => {
    // Only for the customer the link named — never after the operator switched to someone else.
    if (billPrefilled.current || !presetBill || !pending.data || !customer || customer.customerKey !== preset.data?.[0]?.customerKey) return;
    billPrefilled.current = true;
    const b = pending.data.find((x) => x.id === presetBill);
    if (b) setAllocations({ [b.id]: paiseText(toPaise(b.outstandingAmount)) });
    else setPresetNote('The bill you came from has nothing outstanding. Other pending bills of this customer are listed below.');
  }, [pending.data, presetBill, preset.data, customer]);

  /* ---- accounts for the chosen mode; the only one is picked for you ---- */
  const accounts = usePaymentAccounts(mode);
  useEffect(() => {
    if (!accountId && accounts.data?.length === 1) setAccountId(accounts.data[0].id);
  }, [accounts.data, accountId]);

  const pickMode = (m: PaymentMode) => {
    if (m === mode) return;
    setMode(m);
    setAccountId('');
    setErrors((e) => ({ ...e, accountId: undefined }));
  };

  const pickCustomer = (c: ReceivableCustomer | null) => {
    setCustomer(c);
    setAllocations({});
    setBillErrors({});
    setPresetNote(null);
    setErrors((e) => ({ ...e, customerMobile: undefined, allocations: undefined, amount: undefined }));
  };

  const changeAllocations = (next: Allocations, touched: string[]) => {
    setAllocations(next);
    setBillErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !touched.includes(id))));
    setErrors((e) => ({ ...e, allocations: undefined, amount: undefined }));
  };

  /* ---- the summary, in paise ---- */
  const allocated = allocatedPaise(bills, allocations);
  const outstanding = customer ? toPaise(customer.totalOutstanding) : 0;
  const rowsInvalid = bills.some((b) => allocationError(allocations[b.id], b) !== null);

  const save = useSave<Record<string, unknown>, ReceiptRecord>({ invalidate: RECEIPT_INVALIDATES, onSuccess: (r) => nav(`/modules/receipts/${r.id}`, { replace: true }) });

  /** Server validation back onto the screen; allocation paths are indexes into what was SENT. */
  const showServerErrors = (e: unknown, sent: { billId: string }[]) => {
    if (!(e instanceof ApiError) || !Array.isArray(e.details)) return;
    const head: HeaderErrors = {};
    const rows: Record<string, string> = {};
    for (const d of e.details as { path?: (string | number)[]; message: string }[]) {
      const [first, index] = d.path ?? [];
      if (first === 'allocations' && typeof index === 'number' && sent[index]) rows[sent[index].billId] = d.message;
      else if (first === 'receiptDate' || first === 'customerMobile' || first === 'accountId' || first === 'remark' || first === 'amount' || first === 'allocations') head[first] = d.message;
    }
    setErrors(head);
    setBillErrors(rows);
  };

  const submit = () => {
    if (save.isPending) return;
    const next: HeaderErrors = {};
    if (!receiptDate) next.receiptDate = 'Receipt date is required';
    if (!customer) next.customerMobile = 'Choose the customer who paid';
    if (!accountId) next.accountId = 'Account is required';
    if (customer && !rowsInvalid && allocated <= 0) next.allocations = 'Allocate the amount to at least one bill';
    const used = bills.filter((b) => (typedPaise(allocations[b.id]) ?? 0) > 0);
    if (used.length > RECEIPT_LIMITS.maxAllocations) next.allocations = `A receipt can settle at most ${RECEIPT_LIMITS.maxAllocations} bills — this one has ${used.length}. Record the rest on another receipt.`;
    // Plain YYYY-MM-DD strings: comparing them is comparing the calendar dates. The server re-checks.
    const latest = used.reduce<string | null>((max, b) => (!max || b.billDate > max ? b.billDate : max), null);
    if (receiptDate && latest && receiptDate < latest) next.receiptDate = `Cannot be before the date of a bill it settles (${fmtDate(latest)})`;
    setErrors(next);
    if (Object.keys(next).length > 0 || rowsInvalid || !customer) return;

    const sent = bills
      .map((b) => ({ billId: b.id, paise: typedPaise(allocations[b.id]) ?? 0 }))
      .filter((a) => a.paise > 0)
      .map((a) => ({ billId: a.billId, amount: fromPaise(a.paise) }));
    save.mutate(
      {
        method: 'post',
        url: RECEIPTS_URL,
        body: { receiptDate, customerMobile: customer.customerKey, paymentMode: mode, accountId, amount: fromPaise(allocated), remark: remark.trim() || null, allocations: sent },
      },
      { onError: (e) => showServerErrors(e, sent) },
    );
  };

  // Ctrl/Cmd+S saves from anywhere on the page. Escape is deliberately NOT bound: nothing
  // financial is ever abandoned by a stray key.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const busy = save.isPending;
  const accountOptions = (accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.accountName} (${a.groupName})` }));

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Receipts', href: LIST }, { label: 'New' }]} />
      <div className="mb-3 flex items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to receipts" title="Back to receipts" onClick={() => nav(LIST)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[20px] font-semibold text-gray-900">New Receipt</h2>
      </div>

      <form
        className="space-y-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[120px_170px_minmax(0,1fr)]">
          <Field label="Receipt No.">
            <div className="input flex items-center bg-gray-50 text-gray-500" title="The number is assigned when the receipt is saved">Auto</div>
          </Field>
          <Field label="Date" required error={errors.receiptDate}>
            <DateInput value={receiptDate} onChange={setReceiptDate} disabled={busy} aria-label="Receipt date" />
          </Field>
          <Field label="Customer" required error={errors.customerMobile} className="sm:col-span-2 lg:col-span-1">
            {presetKey && preset.isLoading ? (
              <div className="input flex items-center gap-2 text-gray-500"><Spinner className="h-3.5 w-3.5" /> Loading customer…</div>
            ) : (
              <CustomerPicker value={customer} onChange={pickCustomer} disabled={busy} autoFocus={!presetKey} error={errors.customerMobile} />
            )}
          </Field>
          <Field label="Payment Mode" required>
            <div role="radiogroup" aria-label="Payment mode" className="inline-flex h-10 rounded-lg border border-input bg-surface p-0.5">
              {PAYMENT_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={busy}
                  onClick={() => pickMode(m)}
                  className={cx('min-w-[72px] rounded-md px-3 text-[14px] transition focus:outline-none focus:ring-2 focus:ring-primary/40', mode === m ? 'bg-primary-lighter font-medium text-primary-dark' : 'text-gray-600 hover:bg-gray-50')}
                >
                  {PAYMENT_MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="Account"
            required
            error={errors.accountId ?? (accounts.isError ? 'Accounts could not be loaded' : undefined)}
            hint={
              accounts.data && accounts.data.length === 0 ? (
                <>
                  No {PAYMENT_MODE_LABELS[mode].toLowerCase()} account yet. Create one in <Link className="link" to="/modules/masters/accounts">Account Master</Link> under a {mode} group.
                </>
              ) : undefined
            }
          >
            <Select
              value={accountId}
              onChange={(v) => {
                setAccountId(v);
                setErrors((e) => ({ ...e, accountId: undefined }));
              }}
              options={accountOptions}
              placeholder={accounts.isLoading ? 'Loading…' : `Select ${PAYMENT_MODE_LABELS[mode].toLowerCase()} account`}
              disabled={busy || accounts.isLoading}
            />
          </Field>
          <Field label="Remark" error={errors.remark} className="sm:col-span-2 lg:col-span-1">
            <TextInput value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={RECEIPT_LIMITS.remark} placeholder="e.g. UPI ref 4512, cheque no." disabled={busy} />
          </Field>
        </div>

        <div className="card p-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="section-title">Pending Bills</h3>
            {customer && <span className="text-[12px] text-gray-500">Oldest first</span>}
          </div>
          {presetNote && <p className="mb-2 text-[12px] text-amber-700">{presetNote}</p>}
          {customer && pending.data && bills.length < customer.pendingBillCount && (
            <p className="mb-2 text-[12px] text-amber-700">Showing the oldest {bills.length} of {customer.pendingBillCount} pending bills. Settle these, then record another receipt for the rest.</p>
          )}
          {!customer ? (
            <p className="py-6 text-center text-[13px] text-gray-500">Choose a customer to see the bills they owe.</p>
          ) : (
            <PendingBillsAllocation
              bills={bills}
              loading={pending.isLoading}
              error={pending.isError ? (pending.error instanceof Error ? pending.error.message : 'Pending bills could not be loaded.') : null}
              allocations={allocations}
              serverErrors={billErrors}
              onChange={changeAllocations}
              disabled={busy}
            />
          )}
          {(errors.allocations || errors.amount) && <p className="mt-2 text-[12px] text-red-600">{errors.allocations ?? errors.amount}</p>}
        </div>

        <div className="sticky bottom-0 z-10 border-t border-line bg-page py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Customer Outstanding</dt>
                <dd className="tabular-nums text-gray-800">{fmtMoney(fromPaise(outstanding))}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Receipt Amount</dt>
                <dd className="text-[16px] font-semibold tabular-nums text-gray-900">{fmtMoney(fromPaise(allocated))}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Remaining After Receipt</dt>
                <dd className="tabular-nums text-gray-800">{fmtMoney(fromPaise(Math.max(outstanding - allocated, 0)))}</dd>
              </div>
            </dl>
            <div className="ml-auto flex items-center gap-3">
              <button type="button" className="btn-outline" onClick={() => nav(LIST)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || rowsInvalid} title="Save (Ctrl+S)">
                {busy && <Spinner />} Save Receipt
              </button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}
