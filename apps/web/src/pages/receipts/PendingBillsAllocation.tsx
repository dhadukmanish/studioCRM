import { useState } from 'react';
import { RECEIPT_LIMITS, fromPaise, toPaise, type PendingBill } from '@erp/shared';
import { Spinner, TextInput } from '@/components/ui';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { allocationError, autoAllocate, paiseText, payAllInFull, typedPaise, type Allocations } from './allocation';

interface Props {
  bills: PendingBill[];
  loading: boolean;
  error: string | null;
  allocations: Allocations;
  /** Server-side errors for a bill, from a rejected save. Shown until that row is edited. */
  serverErrors: Record<string, string>;
  onChange: (next: Allocations, touchedBillIds: string[]) => void;
  disabled?: boolean;
  /** The form's Amount Received (paise), when typed — what "Spread" puts on the oldest bills. */
  receivedPaise: number | null;
}

/**
 * The customer's pending bills, oldest first, each with the amount this receipt puts against
 * it. On a desktop it is a flat table; below the `sm` breakpoint every bill becomes a compact
 * stacked row, because a six-column money table squeezed into a phone is unusable.
 */
export function PendingBillsAllocation({ bills, loading, error, allocations, serverErrors, onChange, disabled, receivedPaise }: Props) {
  const fmt = useDateFormatters();
  const [autoNote, setAutoNote] = useState<string | null>(null);

  const set = (id: string, v: string) => onChange({ ...allocations, [id]: v }, [id]);
  const full = (b: PendingBill) => set(b.id, paiseText(toPaise(b.outstandingAmount)));

  const runAuto = () => {
    if (!receivedPaise || receivedPaise <= 0) return;
    const r = autoAllocate(bills, receivedPaise);
    onChange(r.allocations, bills.map((b) => b.id));
    const left = fmtMoney(fromPaise(r.leftoverPaise));
    setAutoNote(
      r.capped
        ? `${left} was not put on a bill: a receipt can settle at most ${RECEIPT_LIMITS.maxAllocations} bills. It is kept as advance — apply it from the other bills.`
        : r.leftoverPaise > 0
          ? `${left} is more than these bills owe — it is kept as advance.`
          : null,
    );
  };
  const payAll = () => {
    const r = payAllInFull(bills);
    onChange(r.allocations, bills.map((b) => b.id));
    setAutoNote(r.skipped > 0 ? `Filled the oldest ${RECEIPT_LIMITS.maxAllocations} bills — a receipt can settle at most ${RECEIPT_LIMITS.maxAllocations}. ${r.skipped} more pending ${r.skipped === 1 ? 'bill needs' : 'bills need'} another receipt.` : null);
  };

  if (loading) return <p className="flex items-center gap-2 py-6 text-[13px] text-gray-500"><Spinner className="h-3.5 w-3.5" /> Loading pending bills…</p>;
  if (error) return <p className="py-6 text-[13px] text-red-600">{error}</p>;
  if (bills.length === 0) return <p className="py-6 text-center text-[13px] text-gray-500">This customer has no bill with an outstanding balance.</p>;

  const rowError = (b: PendingBill) => allocationError(allocations[b.id], b) ?? serverErrors[b.id] ?? null;
  const amountInput = (b: PendingBill, className?: string) => (
    <TextInput
      size="sm"
      inputMode="decimal"
      className={cx('text-right tabular-nums', rowError(b) && 'border-red-500', className)}
      placeholder="0.00"
      aria-label={`Amount for bill ${b.bookNumber}/${b.billNumber}`}
      aria-invalid={!!rowError(b)}
      value={allocations[b.id] ?? ''}
      onChange={(e) => set(b.id, e.target.value)}
      disabled={disabled}
    />
  );
  const fullButton = (b: PendingBill) => (
    <button type="button" className="btn-ghost h-8 px-2 text-[13px] text-primary" onClick={() => full(b)} disabled={disabled} aria-label={`Pay bill ${b.bookNumber}/${b.billNumber} in full`}>
      Full
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-outline" onClick={payAll} disabled={disabled}>Pay all in full</button>
        <button type="button" className="btn-outline-primary" onClick={runAuto} disabled={disabled || !receivedPaise} title="Put the amount received on the oldest bills first">
          {receivedPaise ? `Spread ${fmtMoney(fromPaise(receivedPaise))} oldest first` : 'Spread amount received'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => { onChange({}, bills.map((b) => b.id)); setAutoNote(null); }} disabled={disabled}>Clear</button>
      </div>
      {autoNote && <p className="mb-2 text-[12px] text-amber-700">{autoNote}</p>}

      {/* Desktop / tablet: a flat table. */}
      <div className="hidden overflow-x-auto rounded-lg border border-line sm:block">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-head">
              <th scope="col" className="table-head px-3">Bill</th>
              <th scope="col" className="table-head px-3">Date</th>
              <th scope="col" className="table-head px-3 text-right">Bill Total</th>
              <th scope="col" className="table-head px-3 text-right">Paid</th>
              <th scope="col" className="table-head px-3 text-right">Outstanding</th>
              <th scope="col" className="table-head w-[210px] px-3 text-right">Allocate</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className="border-t border-line align-top">
                <td className="px-3 py-1.5 pt-3 font-medium text-gray-900">{b.bookNumber}/{b.billNumber}</td>
                <td className="px-3 py-1.5 pt-3 text-gray-700">{fmt.date(b.billDate)}</td>
                <td className="px-3 py-1.5 pt-3 text-right tabular-nums text-gray-700">{fmtMoney(b.grandTotal)}</td>
                <td className="px-3 py-1.5 pt-3 text-right tabular-nums text-gray-700">{fmtMoney(b.paidAmount)}</td>
                <td className="px-3 py-1.5 pt-3 text-right tabular-nums text-gray-900">{fmtMoney(b.outstandingAmount)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1">
                    {amountInput(b, 'w-[130px]')}
                    {fullButton(b)}
                  </div>
                  {rowError(b) && <p className="mt-0.5 text-right text-[11px] leading-tight text-red-600">{rowError(b)}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: one stacked row per bill. */}
      <ul className="divide-y divide-line rounded-lg border border-line sm:hidden">
        {bills.map((b) => (
          <li key={b.id} className="space-y-1.5 px-3 py-2.5 text-[13px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-gray-900">Bill {b.bookNumber}/{b.billNumber}</span>
              <span className="text-gray-500">{fmt.date(b.billDate)}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-[12px] text-gray-500">
              <span>Total <span className="tabular-nums text-gray-700">{fmtMoney(b.grandTotal)}</span></span>
              <span>Paid <span className="tabular-nums text-gray-700">{fmtMoney(b.paidAmount)}</span></span>
              <span>Due <span className="tabular-nums text-gray-900">{fmtMoney(b.outstandingAmount)}</span></span>
            </div>
            <div className="flex items-center gap-1">
              {amountInput(b, 'flex-1')}
              {fullButton(b)}
            </div>
            {rowError(b) && <p className="text-[11px] leading-tight text-red-600">{rowError(b)}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
