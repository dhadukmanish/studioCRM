import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BILL_MOBILE_DIGITS, PAYMENT_MODES, PAYMENT_MODE_LABELS, RECEIPT_LIMITS, fromPaise, normalizeMobile, toPaise, type PaymentMode, type ReceiptRecord, type ReceivableCustomer } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DateInput, EmptyState, Field, Select, Spinner, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAppointmentsLookup, useSave } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';
import { cx, fmtMoney, todayISO } from '@/lib/format';
import { RECEIPT_INVALIDATES, RECEIPTS_URL, useCustomerAdvance, usePaymentAccounts, usePendingBills, useReceivableCustomer } from '@/lib/receipts';
import { useAuthStore } from '@/store/auth';
import { CustomerPicker } from './CustomerPicker';
import { PendingBillsAllocation } from './PendingBillsAllocation';
import { allocatedPaise, allocationError, autoAllocate, paiseText, typedPaise, type Allocations } from './allocation';

const PERMISSION = 'operations_receipts';
const LIST = '/modules/receipts';

/**
 * Receive Payment — customer first: pick who paid, see what they owe oldest first, put the money
 * against bills, and save. One concept for the staff member, whatever the context:
 *
 *  - money against bills: allocate it (the amount received defaults to what is allocated);
 *  - more than the bills: the rest is kept as ADVANCE — shown, never silently applied;
 *  - no bill yet (type the 10-digit mobile, or come from an appointment): the whole amount is advance.
 *
 * The number, each bill's outstanding and (once they have a bill) the customer's name are the
 * server's — it re-reads all of them under lock when this is saved. Receipts are never edited, so
 * this page only ever creates one.
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

type HeaderErrors = Partial<Record<'receiptDate' | 'customerMobile' | 'customerName' | 'accountId' | 'remark' | 'amount' | 'allocations', string>>;

/** A customer the server does not know yet — a 10-digit mobile paying an advance before any bill. */
const newCustomer = (key: string, name = ''): ReceivableCustomer => ({ customerKey: key, customerName: name, mobileNumber: key, billCount: 0, pendingBillCount: 0, totalBilled: 0, totalPaid: 0, totalOutstanding: 0 });

function ReceiptForm() {
  const nav = useNavigate();
  const { date: fmtDate } = useDateFormatters();
  const [params] = useSearchParams();
  const presetKey = params.get('customer');
  const presetBill = params.get('bill');
  const presetName = params.get('name') ?? '';
  const can = useAuthStore((s) => s.can);

  const [receiptDate, setReceiptDate] = useState(todayISO());
  const [customer, setCustomer] = useState<ReceivableCustomer | null>(null);
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [accountId, setAccountId] = useState('');
  const [remark, setRemark] = useState('');
  const [allocations, setAllocations] = useState<Allocations>({});
  /** What was received. Blank = exactly what is allocated to bills; more = the rest is advance. */
  const [amountText, setAmountText] = useState('');
  /** Only for a customer with no bill yet — once they have one, the bill names them. */
  const [customerName, setCustomerName] = useState('');
  /** The one question asked when money is typed but put on no pending bill. */
  const [askAdvance, setAskAdvance] = useState(false);
  const [keepAdvance, setKeepAdvance] = useState(false);
  const [errors, setErrors] = useState<HeaderErrors>({});
  const [billErrors, setBillErrors] = useState<Record<string, string>>({});
  const [presetNote, setPresetNote] = useState<string | null>(null);

  /* ---- ?customer=<key>&bill=<id>: preselect the customer, prefill that bill ---- */
  const preset = useReceivableCustomer(presetKey);
  const presetApplied = useRef(false);
  useEffect(() => {
    if (presetApplied.current || !preset.data) return;
    presetApplied.current = true;
    if (preset.data[0]) {
      setCustomer(preset.data[0]);
      if (preset.data[0].billCount === 0) setCustomerName(preset.data[0].customerName || presetName);
    } else if (presetKey && normalizeMobile(presetKey).length === BILL_MOBILE_DIGITS) {
      // From an appointment: someone with no bill and no receipt yet — an advance before any bill.
      setCustomer(newCustomer(normalizeMobile(presetKey), presetName));
      setCustomerName(presetName);
    } else setPresetNote('That customer could not be found. Search for the customer below.');
  }, [preset.data, presetKey, presetName]);

  /* ---- a new customer's name: from their latest appointment, when there is one ---- */
  const isNew = !!customer && customer.billCount === 0;
  const booked = useAppointmentsLookup(isNew && !customerName && can('operations_appointments') ? customer.customerKey : '');
  useEffect(() => {
    if (isNew && !customerName && booked.data?.[0]) setCustomerName(booked.data[0].customerName);
  }, [isNew, customerName, booked.data]);
  const advance = useCustomerAdvance(customer?.customerKey);

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
    setCustomerName(c && c.billCount === 0 ? c.customerName : '');
    setAllocations({});
    setBillErrors({});
    setPresetNote(null);
    setErrors((e) => ({ ...e, customerMobile: undefined, allocations: undefined, amount: undefined }));
  };

  const changeAllocations = (next: Allocations, touched: string[]) => {
    setAllocations(next);
    setAskAdvance(false);
    setKeepAdvance(false);
    setBillErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !touched.includes(id))));
    setErrors((e) => ({ ...e, allocations: undefined, amount: undefined }));
  };

  /* ---- the summary, in paise ---- */
  const allocated = allocatedPaise(bills, allocations);
  const outstanding = customer ? toPaise(customer.totalOutstanding) : 0;
  const rowsInvalid = bills.some((b) => allocationError(allocations[b.id], b) !== null);
  const typedAmount = typedPaise(amountText);
  /** Received: what was typed, or — left blank — exactly what went to bills. */
  const received = amountText.trim() === '' ? allocated : (typedAmount ?? 0);
  const keptAsAdvance = Math.max(received - allocated, 0);

  const save = useSave<Record<string, unknown>, ReceiptRecord>({ invalidate: RECEIPT_INVALIDATES, onSuccess: (r) => nav(`/modules/receipts/${r.id}`, { replace: true }) });

  /** Server validation back onto the screen; allocation paths are indexes into what was SENT. */
  const showServerErrors = (e: unknown, sent: { billId: string }[]) => {
    if (!(e instanceof ApiError) || !Array.isArray(e.details)) return;
    const head: HeaderErrors = {};
    const rows: Record<string, string> = {};
    for (const d of e.details as { path?: (string | number)[]; message: string }[]) {
      const [first, index] = d.path ?? [];
      if (first === 'allocations' && typeof index === 'number' && sent[index]) rows[sent[index].billId] = d.message;
      else if (first === 'receiptDate' || first === 'customerMobile' || first === 'customerName' || first === 'accountId' || first === 'remark' || first === 'amount' || first === 'allocations') head[first] = d.message;
    }
    setErrors(head);
    setBillErrors(rows);
  };

  const submit = (keepAsAdvance = keepAdvance) => {
    if (save.isPending) return;
    const next: HeaderErrors = {};
    if (!receiptDate) next.receiptDate = 'Receipt date is required';
    if (!customer) next.customerMobile = 'Choose the customer who paid';
    if (!accountId) next.accountId = 'Account is required';
    if (isNew && !customerName.trim()) next.customerName = 'Customer name is required';
    if (amountText.trim() !== '' && typedAmount === null) next.amount = 'Enter an amount with at most 2 decimals';
    else if (customer && !rowsInvalid && received <= 0) next.amount = bills.length ? 'Enter the amount received, or put an amount against a bill' : 'Enter the amount received';
    else if (received < allocated) next.amount = `The amount received cannot be less than the ${fmtMoney(fromPaise(allocated))} put against bills`;
    const used = bills.filter((b) => (typedPaise(allocations[b.id]) ?? 0) > 0);
    if (used.length > RECEIPT_LIMITS.maxAllocations) next.allocations = `A receipt can settle at most ${RECEIPT_LIMITS.maxAllocations} bills — this one has ${used.length}. Record the rest on another receipt.`;
    // Plain YYYY-MM-DD strings: comparing them is comparing the calendar dates. The server re-checks.
    const latest = used.reduce<string | null>((max, b) => (!max || b.billDate > max ? b.billDate : max), null);
    if (receiptDate && latest && receiptDate < latest) next.receiptDate = `Cannot be before the date of a bill it settles (${fmtDate(latest)})`;
    setErrors(next);
    if (Object.keys(next).length > 0 || rowsInvalid || !customer) return;
    // Money typed with bills pending but none of it put on a bill: ask once, never guess. Keeping it
    // as advance leaves every bill owing until someone applies it.
    if (bills.length > 0 && allocated === 0 && received > 0 && !keepAsAdvance) {
      setAskAdvance(true);
      return;
    }

    const sent = bills
      .map((b) => ({ billId: b.id, paise: typedPaise(allocations[b.id]) ?? 0 }))
      .filter((a) => a.paise > 0)
      .map((a) => ({ billId: a.billId, amount: fromPaise(a.paise) }));
    save.mutate(
      {
        method: 'post',
        url: RECEIPTS_URL,
        body: {
          receiptDate,
          customerMobile: customer.customerKey,
          customerName: isNew ? customerName.trim() : null,
          paymentMode: mode,
          accountId,
          amount: fromPaise(received),
          remark: remark.trim() || null,
          allocations: sent,
        },
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
      <Crumb items={[{ label: 'Operations' }, { label: 'Receipts', href: LIST }, { label: 'Receive Payment' }]} />
      <div className="mb-3 flex items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to receipts" title="Back to receipts" onClick={() => nav(LIST)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[20px] font-semibold text-gray-900">Receive Payment</h2>
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
          {isNew && (
            <Field label="Customer Name" required error={errors.customerName} hint="No bill yet — this is an advance. Their first bill will carry this mobile.">
              <TextInput
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setErrors((x) => ({ ...x, customerName: undefined }));
                }}
                maxLength={RECEIPT_LIMITS.customerName}
                placeholder="Customer name"
                disabled={busy}
              />
            </Field>
          )}
          <Field
            label="Amount Received"
            required={bills.length === 0}
            error={errors.amount}
            hint={bills.length ? 'Leave blank to receive exactly what you put against bills.' : undefined}
          >
            <TextInput
              inputMode="decimal"
              className="text-right tabular-nums"
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setAskAdvance(false);
                setKeepAdvance(false);
                setErrors((x) => ({ ...x, amount: undefined }));
              }}
              placeholder={allocated > 0 ? paiseText(allocated) : '0.00'}
              aria-label="Amount received"
              disabled={busy}
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
            <p className="py-6 text-center text-[13px] text-gray-500">Choose a customer to see the bills they owe — or type a 10-digit mobile to receive an advance.</p>
          ) : isNew || (pending.data && bills.length === 0) ? (
            <p className="py-6 text-center text-[13px] text-gray-500">
              No bill is pending. The whole amount is kept as <span className="text-gray-800">advance</span> — apply it from the bill once there is one.
            </p>
          ) : (
            <PendingBillsAllocation
              bills={bills}
              loading={pending.isLoading}
              error={pending.isError ? (pending.error instanceof Error ? pending.error.message : 'Pending bills could not be loaded.') : null}
              allocations={allocations}
              serverErrors={billErrors}
              onChange={changeAllocations}
              receivedPaise={amountText.trim() !== '' && typedAmount ? typedAmount : null}
              disabled={busy}
            />
          )}
          {errors.allocations && <p className="mt-2 text-[12px] text-red-600">{errors.allocations}</p>}
          {askAdvance && (
            <div role="alert" className="mt-3 flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary-50 px-3 py-2.5 text-[13px] text-gray-800 sm:flex-row sm:items-center">
              <span className="flex-1">
                {fmtMoney(fromPaise(received))} is not on any bill yet. Put it on the oldest pending bills, or keep it as advance?
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary max-sm:h-10"
                  onClick={() => {
                    setAllocations(autoAllocate(bills, received).allocations);
                    setAskAdvance(false);
                  }}
                >
                  Put on bills
                </button>
                <button
                  type="button"
                  className="btn-outline max-sm:h-10"
                  onClick={() => {
                    setKeepAdvance(true);
                    setAskAdvance(false);
                    submit(true);
                  }}
                >
                  Keep as advance
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 border-t border-line bg-page py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Customer Outstanding</dt>
                <dd className="tabular-nums text-gray-800">{fmtMoney(fromPaise(outstanding))}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Received</dt>
                <dd className="text-[16px] font-semibold tabular-nums text-gray-900">{fmtMoney(fromPaise(received))}</dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-gray-500">Against Bills</dt>
                <dd className="tabular-nums text-gray-800">{fmtMoney(fromPaise(allocated))}</dd>
              </div>
              {keptAsAdvance > 0 && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-gray-500">Kept as Advance</dt>
                  <dd className="font-medium tabular-nums text-primary-dark">{fmtMoney(fromPaise(keptAsAdvance))}</dd>
                </div>
              )}
              {!isNew && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-gray-500">Remaining After Receipt</dt>
                  <dd className="tabular-nums text-gray-800">{fmtMoney(fromPaise(Math.max(outstanding - allocated, 0)))}</dd>
                </div>
              )}
              {(advance.data?.availableAdvance ?? 0) > 0 && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-gray-500">Advance Already Available</dt>
                  <dd className="tabular-nums text-gray-800">{fmtMoney(advance.data!.availableAdvance)}</dd>
                </div>
              )}
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
