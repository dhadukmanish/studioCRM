import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, RECEIPT_LIMITS, fromPaise, toPaise, type PaymentMode, type ReceiptRecord } from '@erp/shared';
import { DateInput, Field, Modal, Select, Spinner, TextInput } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cx, fmtMoney, todayISO } from '@/lib/format';
import { toast } from '@/lib/toast';
import { RECEIPT_INVALIDATES, RECEIPTS_URL, usePaymentAccounts } from '@/lib/receipts';
import { splitPayment, typedPaise } from './allocation';

export interface ReceivePaymentFor {
  /** The customer key (normalized 10-digit mobile) the receipt is made against. */
  customerKey: string;
  customerName: string;
  /** Paying a bill: its id, "2026-27/5" and what it still owes (the server's figure). None = an advance. */
  bill?: { id: string; reference: string; due: number };
}

type Errors = Partial<Record<'amount' | 'accountId' | 'receiptDate' | 'form', string>>;

/**
 * Receive payment — the everyday version, opened from where the staff member already is (a bill, a
 * row on Today's Work, an appointment). The customer and bill are known, so it asks only: how much,
 * cash or bank, which account, which day. No allocation grid, no receipt vocabulary:
 *
 *   from a bill          the amount defaults to what is Due; up to Due settles the bill, anything
 *                        beyond is kept as Advance (said plainly before saving)
 *   with no bill yet     the whole amount is Advance, used on their bill later with one click
 *
 * It posts the same receipt the full Receipts form does, so every rule — amount >= what goes on
 * bills, never more than Due, the bill's lock, numbering, audit — stays the server's. Money needs
 * an explicit "Receive ₹X" click; nothing is saved by opening this.
 */
export function ReceivePaymentDialog({ open, onClose, payment }: { open: boolean; onClose: () => void; payment: ReceivePaymentFor | null }) {
  if (!open || !payment) return null;
  return <ReceivePaymentForm onClose={onClose} p={payment} />;
}

function ReceivePaymentForm({ onClose, p }: { onClose: () => void; p: ReceivePaymentFor }) {
  const qc = useQueryClient();
  const bill = p.bill;
  const [amountText, setAmountText] = useState(bill && bill.due > 0 ? bill.due.toFixed(2) : '');
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [accountId, setAccountId] = useState('');
  const [receiptDate, setReceiptDate] = useState(todayISO());
  const [noteOpen, setNoteOpen] = useState(false);
  const [remark, setRemark] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const accounts = usePaymentAccounts(mode);
  useEffect(() => {
    if (!accountId && accounts.data?.length === 1) setAccountId(accounts.data[0].id);
  }, [accounts.data, accountId]);
  useEffect(() => amountRef.current?.select(), []);

  const received = typedPaise(amountText);
  const split = bill ? splitPayment(received ?? 0, toPaise(bill.due)) : null;

  const submit = async () => {
    if (busy) return;
    const next: Errors = {};
    if (received === null) next.amount = 'Enter an amount with at most 2 decimals';
    else if (received <= 0) next.amount = 'Enter the amount received';
    if (!accountId) next.accountId = 'Choose the account the money went into';
    if (!receiptDate) next.receiptDate = 'Date is required';
    setErrors(next);
    if (Object.keys(next).length || received === null) return;

    setBusy(true);
    try {
      const r = await api.raw<{ message: string; data: ReceiptRecord }>('POST', RECEIPTS_URL, {
        receiptDate,
        customerMobile: p.customerKey,
        customerName: p.customerName || null,
        paymentMode: mode,
        accountId,
        amount: fromPaise(received),
        remark: remark.trim() || null,
        allocations: bill && split && split.toBill > 0 ? [{ billId: bill.id, amount: fromPaise(split.toBill) }] : [],
      });
      RECEIPT_INVALIDATES.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(`${fmtMoney(r.data.amount)} received — Receipt No. ${r.data.receiptNumber}`);
      onClose();
    } catch (e) {
      const got: Errors = {};
      if (e instanceof ApiError && Array.isArray(e.details)) {
        for (const d of e.details as { path?: (string | number)[]; message: string }[]) {
          const [first] = d.path ?? [];
          if (first === 'amount' || first === 'allocations') got.amount = d.message;
          else if (first === 'accountId') got.accountId = d.message;
          else if (first === 'receiptDate') got.receiptDate = d.message;
          else got.form = d.message;
        }
      }
      if (!Object.keys(got).length) got.form = e instanceof ApiError ? e.message : 'The payment could not be saved';
      setErrors(got);
    } finally {
      setBusy(false);
    }
  };

  const accountOptions = (accounts.data ?? []).map((a) => ({ value: a.id, label: a.accountName }));
  const amountLabel = received && received > 0 ? fmtMoney(fromPaise(received)) : '';

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      size="sm"
      title="Receive payment"
      footer={
        <>
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="receive-payment" className="btn-primary max-sm:h-10" disabled={busy}>
            {busy && <Spinner />} Receive {amountLabel}
          </button>
        </>
      }
    >
      <form
        id="receive-payment"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start justify-between gap-3 text-[13px]">
          <div className="min-w-0">
            <p className="truncate text-[14px] text-gray-900">{p.customerName || p.customerKey}</p>
            <p className="text-gray-500">{bill ? `Bill ${bill.reference}` : p.customerKey}</p>
          </div>
          {bill ? (
            <div className="shrink-0 text-right">
              <p className="text-gray-500">Due</p>
              <p className="text-[16px] font-semibold tabular-nums text-gray-900">{fmtMoney(bill.due)}</p>
            </div>
          ) : (
            <span className="badge shrink-0 bg-primary-50 text-primary-dark">Advance</span>
          )}
        </div>

        <Field label="Amount" required error={errors.amount}>
          <TextInput
            ref={amountRef}
            inputMode="decimal"
            className={cx('text-right text-[16px] tabular-nums', errors.amount && 'border-red-500')}
            value={amountText}
            onChange={(e) => {
              setAmountText(e.target.value);
              setErrors((x) => ({ ...x, amount: undefined, form: undefined }));
            }}
            placeholder="0.00"
            aria-label="Amount received"
            autoFocus
            disabled={busy}
          />
        </Field>
        {split && received !== null && received > 0 && (split.toAdvance > 0 || split.stillDue > 0) && (
          <p className="-mt-1 text-[12.5px] text-gray-600">
            {split.toAdvance > 0 ? (
              <>{fmtMoney(fromPaise(split.toAdvance))} more than due — kept as <span className="text-primary-dark">Advance</span>.</>
            ) : (
              <>{fmtMoney(fromPaise(split.stillDue))} will still be due.</>
            )}
          </p>
        )}
        {!bill && <p className="-mt-1 text-[12.5px] text-gray-500">No bill yet — it is kept as advance and used on their bill later.</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid by" required>
            <div role="radiogroup" aria-label="Paid by" className="inline-flex h-10 w-full rounded-lg border border-input bg-surface p-0.5">
              {PAYMENT_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={busy}
                  onClick={() => {
                    if (m === mode) return;
                    setMode(m);
                    setAccountId('');
                    setErrors((x) => ({ ...x, accountId: undefined }));
                  }}
                  className={cx('flex-1 rounded-md px-3 text-[14px] transition focus:outline-none focus:ring-2 focus:ring-primary/40', mode === m ? 'bg-primary-lighter font-medium text-primary-dark' : 'text-gray-600 hover:bg-gray-50')}
                >
                  {PAYMENT_MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Date" required error={errors.receiptDate}>
            <DateInput value={receiptDate} onChange={(v) => { setReceiptDate(v); setErrors((x) => ({ ...x, receiptDate: undefined })); }} disabled={busy} aria-label="Payment date" />
          </Field>
        </div>

        <Field
          label="Account"
          required
          error={errors.accountId ?? (accounts.isError ? 'Accounts could not be loaded' : undefined)}
          hint={
            accounts.data && accounts.data.length === 0 ? (
              <>No {PAYMENT_MODE_LABELS[mode].toLowerCase()} account yet — add one in <Link className="link" to="/modules/masters/accounts">Account Master</Link>.</>
            ) : undefined
          }
        >
          <Select
            value={accountId}
            onChange={(v) => {
              setAccountId(v);
              setErrors((x) => ({ ...x, accountId: undefined }));
            }}
            options={accountOptions}
            placeholder={accounts.isLoading ? 'Loading…' : `Select ${PAYMENT_MODE_LABELS[mode].toLowerCase()} account`}
            disabled={busy || accounts.isLoading}
          />
        </Field>

        {noteOpen ? (
          <Field label="Note">
            <TextInput value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={RECEIPT_LIMITS.remark} placeholder="e.g. UPI ref 4512" disabled={busy} autoFocus />
          </Field>
        ) : (
          <button type="button" className="link text-[13px]" onClick={() => setNoteOpen(true)}>Add a note</button>
        )}

        {errors.form && <p role="alert" className="text-[12.5px] text-red-600">{errors.form}</p>}
      </form>
    </Modal>
  );
}
