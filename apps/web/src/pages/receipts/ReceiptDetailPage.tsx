import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Ban, Printer } from 'lucide-react';
import { PAYMENT_MODE_LABELS, type ReceiptRecord } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { EmptyState, Spinner } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { useCompanyProfile, useDateFormatters } from '@/lib/settings';
import { useReceipt } from '@/lib/receipts';
import { useAuthStore } from '@/store/auth';
import { CancelReceiptDialog } from './CancelReceiptDialog';
import { ReceiptPrintCopy } from './ReceiptPrintCopy';
import { BillPaymentStatusBadge, ReceiptStatusBadge } from './StatusBadges';

const LIST = '/modules/receipts';

/** One receipt, read-only — a receipt is never edited, only cancelled. `?print=1` prints it on open. */
export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const q = useReceipt(id);

  if (q.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <EmptyState
        title="Receipt could not be loaded"
        description={q.error instanceof Error ? q.error.message : 'The receipt may not exist.'}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-outline" onClick={() => nav(LIST)}>Back to receipts</button>
            <button type="button" className="btn-primary" onClick={() => q.refetch()}>Try again</button>
          </div>
        }
      />
    );
  }
  return <ReceiptDetail receipt={q.data} />;
}

function ReceiptDetail({ receipt }: { receipt: ReceiptRecord }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const can = useAuthStore((s) => s.can);
  const fmt = useDateFormatters();
  const company = useCompanyProfile();
  const [cancelling, setCancelling] = useState(false);
  const canCancel = can('operations_receipts', 'update') && receipt.status === 'ACTIVE';
  const canOpenBills = can('operations_billing');
  const cancelled = receipt.status === 'CANCELLED';

  // Arrived from the list's Print action: print once the letterhead has had its chance to load.
  // The param is dropped only after printing, so Back or a reload never prints again.
  const wantsPrint = params.get('print') === '1';
  const printed = useRef(false);
  useEffect(() => {
    if (!wantsPrint || company.isLoading || printed.current) return;
    printed.current = true;
    setTimeout(() => {
      window.print();
      setParams({}, { replace: true });
    }, 150);
  }, [wantsPrint, company.isLoading, setParams]);

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Receipts', href: LIST }, { label: `#${receipt.receiptNumber}` }]} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn" aria-label="Back to receipts" title="Back to receipts" onClick={() => nav(LIST)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-[20px] font-semibold text-gray-900">Receipt #{receipt.receiptNumber}</h2>
        <ReceiptStatusBadge status={receipt.status} />
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn-outline" onClick={() => window.print()}>
            <Printer className="h-4 w-4" strokeWidth={1.5} /> Print
          </button>
          {canCancel && (
            <button type="button" className="btn-outline text-red-600" onClick={() => setCancelling(true)}>
              <Ban className="h-4 w-4" strokeWidth={1.5} /> Cancel receipt
            </button>
          )}
        </div>
      </div>

      {cancelled && (
        <div className="mb-3 rounded-lg border border-line bg-red-50 px-4 py-2.5 text-[13px] text-red-700">
          Cancelled{receipt.cancelledAt && ` on ${fmt.stampTime(receipt.cancelledAt)}`}
          {receipt.cancelledByName && ` by ${receipt.cancelledByName}`}.{' '}
          {receipt.cancelReason ? <>Reason: {receipt.cancelReason}. </> : null}
          Its amounts no longer count towards the bills below.
        </div>
      )}

      <div className="space-y-3">
        <div className="card p-4">
          <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Receipt Date">{fmt.date(receipt.receiptDate)}</Item>
            <Item label="Customer">
              {receipt.customerName}
              <span className="ml-2 text-gray-500">{receipt.mobileNumber}</span>
            </Item>
            <Item label="Payment">
              {PAYMENT_MODE_LABELS[receipt.paymentMode]} <span className="text-gray-500">· {receipt.accountName}</span>
            </Item>
            <Item label="Amount">
              <span className={cancelled ? 'text-[16px] tabular-nums text-gray-400 line-through' : 'text-[16px] font-semibold tabular-nums text-gray-900'}>{fmtMoney(receipt.amount)}</span>
            </Item>
            {receipt.remark && <Item label="Remark" wide>{receipt.remark}</Item>}
          </dl>
        </div>

        <div className="card overflow-hidden">
          <h3 className="section-title px-4 pb-2 pt-3">Bills Settled</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-head">
                  <th scope="col" className="table-head px-4">Bill</th>
                  <th scope="col" className="table-head px-4">Bill Date</th>
                  <th scope="col" className="table-head px-4 text-right">Bill Total</th>
                  <th scope="col" className="table-head px-4 text-right">Paid Now</th>
                  <th scope="col" className="table-head px-4 text-right">Outstanding Now</th>
                  <th scope="col" className="table-head px-4">Status</th>
                  <th scope="col" className="table-head px-4 text-right">This Receipt</th>
                </tr>
              </thead>
              <tbody>
                {receipt.allocations.map((a) => (
                  <tr key={a.id} className="border-t border-line">
                    <td className="whitespace-nowrap px-4 py-2">
                      {canOpenBills ? <Link className="link" to={`/modules/billing/${a.billId}`}>{a.bookNumber}/{a.billNumber}</Link> : `${a.bookNumber}/${a.billNumber}`}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-gray-700">{fmt.date(a.billDate)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtMoney(a.grandTotal)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtMoney(a.paidAmount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700">{fmtMoney(a.outstandingAmount)}</td>
                    <td className="px-4 py-2"><BillPaymentStatusBadge status={a.paymentStatus} /></td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-900">{fmtMoney(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[12px] text-gray-500">
          Created {fmt.stampTime(receipt.createdAt)}
          {receipt.createdByName && ` by ${receipt.createdByName}`}. Paid Now and Outstanding Now are each bill’s position today, across all its active receipts.
        </p>
      </div>

      <ReceiptPrintCopy receipt={receipt} company={company.data} />
      <CancelReceiptDialog receipt={cancelling ? receipt : null} onClose={() => setCancelling(false)} />
    </>
  );
}

function Item({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2 lg:col-span-4' : undefined}>
      <dt className="mb-0.5 text-[12px] text-gray-500">{label}</dt>
      <dd className="text-gray-800">{children}</dd>
    </div>
  );
}
