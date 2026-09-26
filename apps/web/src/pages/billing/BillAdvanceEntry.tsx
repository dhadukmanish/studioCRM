import { useEffect } from 'react';
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, fromPaise, toPaise, type PaymentMode } from '@erp/shared';
import { Select, TextInput } from '@/components/ui';
import { cx, fmtMoney } from '@/lib/format';
import { usePaymentAccounts } from '@/lib/receipts';
import { splitPayment, typedPaise } from '@/pages/receipts/allocation';

/** What the operator typed into a NEW bill's Advance box. Blank or 0 = no advance. */
export interface AdvanceDraft {
  amount: string;
  mode: PaymentMode;
  accountId: string;
}
export const EMPTY_ADVANCE: AdvanceDraft = { amount: '', mode: 'CASH', accountId: '' };
export type AdvanceErrors = Partial<Record<'amount' | 'paymentMode' | 'accountId', string>>;

/** Paise typed, 0 for blank, null when it is not money. */
export const advancePaise = (d: AdvanceDraft) => typedPaise(d.amount);

/**
 * The payload's `advance`, or the field errors that stop the save. The server re-checks all of it
 * (amount, Cash/Bank account, permission) inside the bill's own transaction.
 */
export function advancePayload(d: AdvanceDraft): { advance: { amount: number; paymentMode: PaymentMode; accountId: string } | null; errors: AdvanceErrors } {
  const p = advancePaise(d);
  if (p === null) return { advance: null, errors: { amount: 'Up to 2 decimals' } };
  if (p === 0) return { advance: null, errors: {} };
  if (!d.accountId) return { advance: null, errors: { accountId: 'Choose the account' } };
  return { advance: { amount: fromPaise(p), paymentMode: d.mode, accountId: d.accountId }, errors: {} };
}

/**
 * The money rows of a NEW bill's totals, under Grand Total:
 *
 *   Advance        [ 5000 ]          money received NOW, with this bill
 *   Received via   Cash | Bank       only once an amount is typed; the only account is preselected
 *   Account        [ CASH IN HAND ]
 *   Due            ₹15,000.00        Grand Total less what goes on this bill — Grand Total never changes
 *
 * On save it becomes a real receipt against the bill (same transaction). Money the customer paid
 * EARLIER is a different thing — shown as "Advance available", applied after saving, never mixed in here.
 */
export function BillAdvanceEntry({ draft, onChange, errors, grandTotal, earlierAdvance, disabled }: {
  draft: AdvanceDraft;
  onChange: (next: AdvanceDraft) => void;
  errors: AdvanceErrors;
  grandTotal: number;
  earlierAdvance: number;
  disabled?: boolean;
}) {
  const typed = advancePaise(draft);
  const receiving = typed !== null && typed > 0;
  const split = splitPayment(typed ?? 0, toPaise(grandTotal));

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <dt className="pt-1.5 text-gray-500">Advance</dt>
        <dd className="flex flex-col items-end gap-1">
          <TextInput
            size="sm"
            inputMode="decimal"
            className={cx('w-[120px] text-right tabular-nums', errors.amount && 'border-red-500')}
            placeholder="0.00"
            aria-label="Advance received now"
            value={draft.amount}
            onChange={(e) => onChange({ ...draft, amount: e.target.value })}
            disabled={disabled}
          />
          {errors.amount && <p className="text-[11px] text-red-600">{errors.amount}</p>}
        </dd>
      </div>
      {receiving && <AdvancePayment draft={draft} onChange={onChange} errors={errors} disabled={disabled} />}
      {earlierAdvance > 0 && (
        <p className="text-right text-[11.5px] leading-snug text-primary-dark">
          {fmtMoney(earlierAdvance)} advance received earlier — apply it after saving.
        </p>
      )}
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-[14px] font-medium text-gray-700">Due</dt>
        <dd className="text-[15px] font-semibold tabular-nums text-gray-900">{fmtMoney(fromPaise(split.stillDue))}</dd>
      </div>
      {receiving && split.toAdvance > 0 && (
        <p className="text-right text-[11.5px] text-gray-500">{fmtMoney(fromPaise(split.toAdvance))} more than the bill — kept as advance.</p>
      )}
    </>
  );
}

function AdvancePayment({ draft, onChange, errors, disabled }: { draft: AdvanceDraft; onChange: (next: AdvanceDraft) => void; errors: AdvanceErrors; disabled?: boolean }) {
  const accounts = usePaymentAccounts(draft.mode);
  useEffect(() => {
    if (!draft.accountId && accounts.data?.length === 1) onChange({ ...draft, accountId: accounts.data[0].id });
  }, [accounts.data, draft, onChange]);
  const options = (accounts.data ?? []).map((a) => ({ value: a.id, label: a.accountName }));

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <dt className="text-gray-500">Received via</dt>
        <dd role="radiogroup" aria-label="Advance received via" className="inline-flex h-8 rounded-lg border border-input bg-surface p-0.5">
          {PAYMENT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={draft.mode === m}
              disabled={disabled}
              onClick={() => m !== draft.mode && onChange({ ...draft, mode: m, accountId: '' })}
              className={cx('min-w-[56px] rounded-md px-2 text-[13px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', draft.mode === m ? 'bg-primary-lighter font-medium text-primary-dark' : 'text-gray-600 hover:bg-gray-50')}
            >
              {PAYMENT_MODE_LABELS[m]}
            </button>
          ))}
        </dd>
      </div>
      <div className="flex items-start justify-between gap-3">
        <dt className="pt-1.5 text-gray-500">Account</dt>
        <dd className="flex w-[180px] flex-col items-end gap-1">
          <Select
            size="sm"
            className="w-full"
            value={draft.accountId}
            onChange={(v) => onChange({ ...draft, accountId: v })}
            options={options}
            placeholder={accounts.isLoading ? 'Loading…' : accounts.data?.length === 0 ? `No ${PAYMENT_MODE_LABELS[draft.mode].toLowerCase()} account` : 'Select account'}
            disabled={disabled || accounts.isLoading}
          />
          {errors.accountId && <p className="text-[11px] text-red-600">{errors.accountId}</p>}
          {errors.paymentMode && <p className="text-[11px] text-red-600">{errors.paymentMode}</p>}
        </dd>
      </div>
    </>
  );
}
