import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, HandCoins, Undo2, Wallet } from 'lucide-react';
import { PAYMENT_MODE_LABELS, toPaise, type BillPaymentHistoryRow } from '@erp/shared';
import { ConfirmDialog, Spinner, TextInput } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { toast } from '@/lib/toast';
import { RECEIPT_INVALIDATES, applyAdvance, reverseAdvanceApplication, useBillPayments } from '@/lib/receipts';
import { ReceivePaymentDialog } from '@/pages/receipts/ReceivePaymentDialog';
import { useAuthStore } from '@/store/auth';
import { ReceiptStatusBadge } from '@/pages/receipts/StatusBadges';

interface Props {
  billId: string;
  /** The bill's customer key (`mobileSearch`) — what a receipt is made against. */
  customerKey: string;
  customerName: string;
  /** "2026-27/5" — how the payment dialog names the bill. */
  reference: string;
  /** Unsaved edits: the figures on screen may not be the saved bill's. */
  dirty: boolean;
}

const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * A saved bill's payment position and history, one line high until opened. Every figure is the
 * server's (`GET /api/bills/:id/payments`): Paid counts receipts and APPLIED advance only — an advance
 * the customer paid but nobody has applied yet is shown beside it, never subtracted from Due.
 * Plain words on screen — Total / Paid / Due / Advance available — whatever the internals call them.
 *
 * Apply Advance is one explicit click on the server's proposal, min(available, outstanding); a
 * smaller amount is one "Change amount" away. Nothing is ever applied automatically. Receive payment
 * opens the quick dialog with this bill and its Due already filled in.
 */
export function BillPaymentsPanel({ billId, customerKey, customerName, reference, dirty }: Props) {
  const q = useBillPayments(billId);
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const can = useAuthStore((s) => s.can);
  const fmt = useDateFormatters();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [applying, setApplying] = useState(false);
  const [reverse, setReverse] = useState<BillPaymentHistoryRow | null>(null);
  const [reversing, setReversing] = useState(false);
  const canReceive = can('operations_receipts', 'create');
  const canReverse = can('operations_receipts', 'update');
  const canOpenReceipts = can('operations_receipts');
  const p = q.data;

  const refresh = () => RECEIPT_INVALIDATES.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const apply = async (amount: number) => {
    setApplying(true);
    try {
      const r = await applyAdvance(billId, amount);
      toast.success(r.message);
      setEditing(false);
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The advance could not be applied');
    } finally {
      setApplying(false);
    }
  };
  const doReverse = async () => {
    if (!reverse?.applicationId) return;
    setReversing(true);
    try {
      const r = await reverseAdvanceApplication(reverse.applicationId);
      toast.success(r.message);
      setReverse(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The advance could not be reversed');
    } finally {
      setReversing(false);
    }
  };

  const typed = amountText.trim();
  const typedOk = MONEY.test(typed) && toPaise(typed) > 0;
  const typedError = !typed ? null : !MONEY.test(typed) ? 'Up to 2 decimals' : p && toPaise(typed) > toPaise(p.advanceToApply) ? `At most ${fmtMoney(p.advanceToApply)}` : null;

  // Paid and Due sit in the bill's totals; this strip is only for acting on money — hidden when there is nothing to do.
  if (p && !p.history.length && p.availableAdvance <= 0 && !(canReceive && p.outstandingAmount > 0)) return null;

  return (
    <div className="card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <h3 className="section-title">Payments</h3>
        {q.isLoading && <span className="flex items-center gap-1.5 text-gray-500"><Spinner className="h-3 w-3" /> Loading…</span>}
        {q.isError && <span className="text-red-600">Payments could not be loaded.</span>}
        {p && (
          <>
            {p.availableAdvance > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-2 py-0.5 text-primary-dark ring-1 ring-primary/20">
                <Wallet className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Advance available <span className="font-medium tabular-nums">{fmtMoney(p.availableAdvance)}</span>
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {p && p.history.length > 0 && (
            <button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              History ({p.history.length})
              <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          )}
          {p && canReceive && p.advanceToApply > 0 && !editing && (
            <>
              <button type="button" className="btn-ghost text-primary" disabled={applying || dirty} onClick={() => { setAmountText(p.advanceToApply.toFixed(2)); setEditing(true); }}>
                Change amount
              </button>
              <button type="button" className="btn-primary max-sm:h-10" disabled={applying || dirty} title={dirty ? 'Save your changes first' : 'Apply the customer’s advance to this bill'} onClick={() => apply(p.advanceToApply)}>
                {applying ? <Spinner /> : <Wallet className="h-4 w-4" strokeWidth={1.5} />} Apply {fmtMoney(p.advanceToApply)}
              </button>
            </>
          )}
          {p && canReceive && editing && (
            <form
              className="flex items-start gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (typedOk && !typedError) apply(Number(typed));
              }}
            >
              <div>
                <TextInput size="sm" autoFocus inputMode="decimal" className={cx('w-[120px] text-right tabular-nums', typedError && 'border-red-500')} aria-label="Advance amount to apply" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
                {typedError && <p className="mt-0.5 text-[11px] text-red-600">{typedError}</p>}
              </div>
              <button type="submit" className="btn-primary" disabled={applying || !typedOk || !!typedError}>{applying && <Spinner />} Apply</button>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          )}
          {p && canReceive && p.outstandingAmount > 0 && !editing && (
            <button
              type="button"
              className={p.advanceToApply > 0 ? 'btn-outline' : 'btn-outline-primary'}
              disabled={dirty}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() => setPaying(true)}
            >
              <HandCoins className="h-4 w-4" strokeWidth={1.5} /> Receive payment
            </button>
          )}
        </div>
      </div>

      {p && open && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-head">
                <th scope="col" className="table-head px-3">Receipt</th>
                <th scope="col" className="table-head px-3">Date</th>
                <th scope="col" className="table-head px-3">How</th>
                <th scope="col" className="table-head px-3">Account</th>
                <th scope="col" className="table-head px-3 text-right">Amount</th>
                <th scope="col" className="table-head px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {p.history.map((h) => (
                <tr key={h.applicationId ?? h.receiptId} className="border-t border-line">
                  <td className="px-3 py-1.5">
                    {canOpenReceipts ? <Link className="link" to={`/modules/receipts/${h.receiptId}`}>#{h.receiptNumber}</Link> : `#${h.receiptNumber}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-700">{fmt.date(h.date)}</td>
                  <td className="px-3 py-1.5 text-gray-700">{h.kind === 'ADVANCE' ? 'Advance applied' : PAYMENT_MODE_LABELS[h.paymentMode]}</td>
                  <td className="px-3 py-1.5 text-gray-700">{h.accountName}</td>
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', h.counts ? 'text-gray-900' : 'text-gray-400 line-through')}>{fmtMoney(h.amount)}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      {h.applicationStatus === 'REVERSED' ? <span className="badge bg-gray-100 text-gray-600">Reversed</span> : <ReceiptStatusBadge status={h.status} />}
                      {h.kind === 'ADVANCE' && h.counts && canReverse && (
                        <button type="button" className="btn-ghost h-7 px-2 text-[12.5px]" onClick={() => setReverse(h)} aria-label={`Reverse advance applied from receipt ${h.receiptNumber}`}>
                          <Undo2 className="h-3.5 w-3.5" /> Reverse
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReceivePaymentDialog open={paying} onClose={() => setPaying(false)} payment={p ? { customerKey, customerName, bill: { id: billId, reference, due: p.outstandingAmount } } : null} />
      <ConfirmDialog
        open={!!reverse}
        onClose={() => setReverse(null)}
        loading={reversing}
        title="Reverse applied advance?"
        confirmText="Reverse"
        message={
          <>
            Take <b>{reverse && fmtMoney(reverse.amount)}</b> of Receipt <b>#{reverse?.receiptNumber}</b> back off this bill? The bill’s outstanding goes up by that amount and the money is available as advance again. The history keeps this entry, marked reversed.
          </>
        }
        onConfirm={doReverse}
      />
    </div>
  );
}
