import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, HandCoins } from 'lucide-react';
import { PAYMENT_MODE_LABELS } from '@erp/shared';
import { Spinner } from '@/components/ui';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { receivePaymentHref, useBillPayments } from '@/lib/receipts';
import { useAuthStore } from '@/store/auth';
import { BillPaymentStatusBadge, ReceiptStatusBadge } from '@/pages/receipts/StatusBadges';

interface Props {
  billId: string;
  /** The bill's customer key (`mobileSearch`) — what a receipt is made against. */
  customerKey: string;
  /** Unsaved edits: receiving a payment would navigate away from them. */
  dirty: boolean;
}

/**
 * A saved bill's payment position and receipt history, one line high until opened. Every figure
 * is the server's (`GET /api/bills/:id/payments`); cancelled receipts stay listed, marked so.
 */
export function BillPaymentsPanel({ billId, customerKey, dirty }: Props) {
  const q = useBillPayments(billId);
  const nav = useNavigate();
  const can = useAuthStore((s) => s.can);
  const fmt = useDateFormatters();
  const [open, setOpen] = useState(false);
  const canReceive = can('operations_receipts', 'create');
  const canOpenReceipts = can('operations_receipts');
  const p = q.data;

  return (
    <div className="card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <h3 className="section-title">Payments</h3>
        {q.isLoading && <span className="flex items-center gap-1.5 text-gray-500"><Spinner className="h-3 w-3" /> Loading…</span>}
        {q.isError && <span className="text-red-600">Payments could not be loaded.</span>}
        {p && (
          <>
            <span className="text-gray-500">Grand Total <span className="tabular-nums text-gray-800">{fmtMoney(p.grandTotal)}</span></span>
            <span className="text-gray-500">Paid <span className="tabular-nums text-gray-800">{fmtMoney(p.paidAmount)}</span></span>
            <span className="text-gray-500">Outstanding <span className="font-medium tabular-nums text-gray-900">{fmtMoney(p.outstandingAmount)}</span></span>
            <BillPaymentStatusBadge status={p.paymentStatus} />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {p && p.history.length > 0 && (
            <button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              History ({p.history.length})
              <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          )}
          {p && canReceive && p.outstandingAmount > 0 && (
            <button
              type="button"
              className="btn-outline-primary"
              disabled={dirty}
              title={dirty ? 'Save your changes first' : 'Record money received against this bill'}
              onClick={() => nav(receivePaymentHref(customerKey, billId))}
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
                <th scope="col" className="table-head px-3">Mode</th>
                <th scope="col" className="table-head px-3">Account</th>
                <th scope="col" className="table-head px-3 text-right">Amount</th>
                <th scope="col" className="table-head px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {p.history.map((h) => (
                <tr key={h.receiptId} className="border-t border-line">
                  <td className="px-3 py-1.5">
                    {canOpenReceipts ? <Link className="link" to={`/modules/receipts/${h.receiptId}`}>#{h.receiptNumber}</Link> : `#${h.receiptNumber}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-gray-700">{fmt.date(h.receiptDate)}</td>
                  <td className="px-3 py-1.5 text-gray-700">{PAYMENT_MODE_LABELS[h.paymentMode]}</td>
                  <td className="px-3 py-1.5 text-gray-700">{h.accountName}</td>
                  <td className={cx('px-3 py-1.5 text-right tabular-nums', h.status === 'CANCELLED' ? 'text-gray-400 line-through' : 'text-gray-900')}>{fmtMoney(h.amount)}</td>
                  <td className="px-3 py-1.5"><ReceiptStatusBadge status={h.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
