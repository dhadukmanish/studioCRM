import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, HandCoins } from 'lucide-react';
import { AGING_BUCKET_LABELS, PAYMENT_MODE_LABELS, type ReceivableBillRow, type ReceivableReceiptRow } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { EmptyState, Spinner, Switch } from '@/components/ui';
import { ApiError, qs } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { receivePaymentHref } from '@/lib/receipts';
import { useCustomerReceivableDetail } from '@/lib/receivables';
import { BillPaymentStatusBadge, ReceiptStatusBadge } from '@/pages/receipts/StatusBadges';
import { KpiStrip, useReportScope, useScopeText } from './reportScope';

/**
 * One customer's receivable (customer = normalized mobile), in the report's scope: the header
 * figures (their Summary row), their bills, and the receipts that settled those bills.
 *
 * A receipt can settle several bills, so each receipt shows its whole amount AND what it put on
 * this customer's bills here; Paid is the sum of the ACTIVE allocations — never receipt totals.
 * Both lists are this customer's COMPLETE set for the scope, so sorting them here is sorting the
 * whole result, not a page.
 */
export default function ReceivableCustomerPage() {
  const { key } = useParams();
  const { scope } = useReportScope();
  const q = useCustomerReceivableDetail(key, scope);
  const nav = useNavigate();
  const fmt = useDateFormatters();
  const can = useAuthStore((s) => s.can);
  const canBill = can('operations_billing', 'read');
  const canReceipts = can('operations_receipts', 'read');
  const canReceive = can('operations_receipts', 'create');
  const [showPaid, setShowPaid] = useState(false);
  const [billList, setBillList] = useListState({ limit: 500, sortBy: 'billDate', sortOrder: 'asc' });
  const [receiptList, setReceiptList] = useListState({ limit: 500, sortBy: 'receiptDate', sortOrder: 'asc' });
  const caption = useScopeText(scope, q.data?.asOf);
  const back = `/modules/reports/receivables${qs({ asOf: scope.asOf, from: scope.from, to: scope.to, book: scope.bookId })}`;

  if (q.isLoading) return <div className="py-16 text-center text-gray-500"><Spinner className="inline h-5 w-5" /></div>;
  if (q.isError || !q.data) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="card">
        <EmptyState
          title={missing ? 'No bills for this customer in this scope' : 'The customer could not be loaded'}
          description={missing ? <Link className="link" to={back}>Back to Receivables</Link> : <button type="button" className="link" onClick={() => q.refetch()}>Retry</button>}
        />
      </div>
    );
  }

  const { customer: c, bills, receipts } = q.data;
  const shownBills = showPaid ? bills : bills.filter((b) => b.outstandingAmount > 0);
  const activeAllocated = receipts.filter((r) => r.status === 'ACTIVE').reduce((s, r) => s + Math.round(r.allocatedAmount * 100), 0) / 100;

  const billColumns: Column<ReceivableBillRow>[] = [
    { key: 'billNumber', header: 'Bill No.', sortValue: (r) => `${r.bookNumber}/${String(r.billNumber).padStart(10, '0')}`, render: (r) => (canBill ? <Link className="link" to={`/modules/billing/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.bookNumber}/{r.billNumber}</Link> : `${r.bookNumber}/${r.billNumber}`) },
    { key: 'billDate', header: 'Date', render: (r) => fmt.date(r.billDate) },
    { key: 'grandTotal', header: 'Grand Total', align: 'right', render: (r) => fmtMoney(r.grandTotal) },
    { key: 'paidAmount', header: 'Paid', align: 'right', render: (r) => <span className={r.paidAmount ? '' : 'text-gray-400'}>{fmtMoney(r.paidAmount)}</span> },
    { key: 'outstandingAmount', header: 'Outstanding', align: 'right', render: (r) => <span className={cx('font-medium', r.outstandingAmount ? 'text-gray-900' : 'text-gray-400')}>{fmtMoney(r.outstandingAmount)}</span> },
    { key: 'ageDays', header: 'Age', align: 'right', render: (r) => <span title={AGING_BUCKET_LABELS[r.agingBucket]}>{r.ageDays} {r.ageDays === 1 ? 'day' : 'days'}</span> },
    { key: 'paymentStatus', header: 'Status', render: (r) => <BillPaymentStatusBadge status={r.paymentStatus} /> },
  ];

  const receiptColumns: Column<ReceivableReceiptRow>[] = [
    { key: 'receiptNumber', header: 'Receipt No.', render: (r) => (canReceipts ? <Link className="link" to={`/modules/receipts/${r.receiptId}`}>{r.receiptNumber}</Link> : r.receiptNumber) },
    { key: 'receiptDate', header: 'Date', render: (r) => fmt.date(r.receiptDate) },
    { key: 'paymentMode', header: 'Mode', render: (r) => PAYMENT_MODE_LABELS[r.paymentMode] },
    { key: 'accountName', header: 'Account', render: (r) => <span className="block max-w-[130px] truncate" title={r.accountName}>{r.accountName}</span> },
    { key: 'receiptAmount', header: 'Receipt Total', align: 'right', render: (r) => fmtMoney(r.receiptAmount) },
    {
      key: 'allocatedAmount',
      header: 'Allocated',
      align: 'right',
      render: (r) => (
        <span title={r.allocations.map((a) => `${a.bookNumber}/${a.billNumber}: ${fmtMoney(a.amount)}`).join('\n')} className={r.status === 'CANCELLED' ? 'text-gray-400 line-through' : 'text-gray-900'}>
          {fmtMoney(r.allocatedAmount)}
        </span>
      ),
    },
    { key: 'bills', header: 'Bills', sortable: false, render: (r) => <span className="block max-w-[150px] truncate text-gray-600" title={r.allocations.map((a) => `${a.bookNumber}/${a.billNumber}`).join(', ')}>{r.allocations.map((a) => `${a.bookNumber}/${a.billNumber} ${fmtMoney(a.amount)}`).join(', ')}</span> },
    { key: 'status', header: 'Status', render: (r) => <ReceiptStatusBadge status={r.status} /> },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Reports' }, { label: 'Receivables', href: back }, { label: c.customerName }]} />
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={back} className="mb-1 inline-flex items-center gap-1 text-[13px] text-gray-500 hover:text-gray-800"><ArrowLeft className="h-3.5 w-3.5" /> Receivables</Link>
          <h2 className="truncate text-[20px] font-semibold text-gray-900" title={c.customerName}>{c.customerName}</h2>
          <div className="text-[13px] text-gray-500">{c.mobileNumber} · {caption}</div>
        </div>
        {canReceive && c.totalOutstanding > 0 && (
          <button type="button" className="btn-primary" onClick={() => nav(receivePaymentHref(c.customerKey))}><HandCoins className="h-4 w-4" /> Receive payment</button>
        )}
      </div>

      <KpiStrip
        items={[
          { label: 'Total Billed', value: fmtMoney(c.totalBilled), hint: 'Grand Total of this customer’s bills in scope' },
          { label: 'Paid', value: fmtMoney(c.totalPaid), hint: 'Active receipt allocations against those bills' },
          { label: 'Outstanding', value: fmtMoney(c.totalOutstanding), hint: 'Total Billed − Paid', strong: true },
          { label: 'Pending bills', value: String(c.pendingBills), hint: 'Bills with something outstanding' },
          { label: 'Oldest pending', value: c.oldestPendingDate ? `${c.oldestPendingAge} days` : '-', hint: c.oldestPendingDate ? `Oldest pending bill dated ${fmt.date(c.oldestPendingDate)}` : 'Nothing outstanding' },
        ]}
      />

      <div className="mb-4">
        <DataTable
          dense
          compact
          clientSide
          hideSearch
          hidePagination
          filterFields={false}
          columns={billColumns}
          rows={shownBills}
          state={billList}
          onStateChange={setBillList}
          rowKey={(r) => r.id}
          onRowClick={canBill ? (r) => nav(`/modules/billing/${r.id}`) : undefined}
          toolbar={
            <div className="flex flex-wrap items-center gap-4">
              <span className="section-title">{showPaid ? 'Bills' : 'Outstanding bills'}</span>
              <Switch checked={showPaid} onChange={setShowPaid} label={`Show paid bills (${bills.length - bills.filter((b) => b.outstandingAmount > 0).length})`} />
            </div>
          }
          emptyTitle={showPaid ? 'No bills in this scope' : 'Nothing outstanding'}
          emptyDescription={showPaid ? undefined : 'Every bill of this customer in this scope is paid.'}
          rowActions={canReceive ? (r) => (r.outstandingAmount > 0 ? <button type="button" className="row-action" title="Receive payment" aria-label={`Receive payment for bill ${r.bookNumber}/${r.billNumber}`} onClick={() => nav(receivePaymentHref(r.customerKey, r.id))}><HandCoins className="h-4 w-4" /></button> : null) : undefined}
          mobileCard={(r) => (
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-gray-900">{r.bookNumber}/{r.billNumber}</span>
                <span className="tabular-nums font-medium text-gray-900">{fmtMoney(r.outstandingAmount)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-gray-500">
                <BillPaymentStatusBadge status={r.paymentStatus} />
                <span>{fmt.date(r.billDate)} · {r.ageDays} days · of {fmtMoney(r.grandTotal)}</span>
              </div>
            </div>
          )}
        />
      </div>

      <DataTable
        dense
        compact
        clientSide
        hideSearch
        hidePagination
        filterFields={false}
        columns={receiptColumns}
        rows={receipts}
        state={receiptList}
        onStateChange={setReceiptList}
        rowKey={(r) => r.receiptId}
        onRowClick={canReceipts ? (r) => nav(`/modules/receipts/${r.receiptId}`) : undefined}
        toolbar={<span className="section-title">Payment history</span>}
        emptyTitle="No receipts yet"
        emptyDescription="No receipt has settled these bills."
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-gray-900">Receipt {r.receiptNumber} · {fmt.date(r.receiptDate)}</span>
              <span className={cx('tabular-nums', r.status === 'CANCELLED' ? 'text-gray-400 line-through' : 'font-medium text-gray-900')}>{fmtMoney(r.allocatedAmount)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-gray-500">
              <ReceiptStatusBadge status={r.status} />
              <span className="truncate">{PAYMENT_MODE_LABELS[r.paymentMode]} · {r.allocations.map((a) => `${a.bookNumber}/${a.billNumber}`).join(', ')}</span>
            </div>
          </div>
        )}
        footer={
          receipts.length > 0 && (
            <div className="border-t border-line bg-head px-4 py-2.5 text-[13px] text-gray-600">
              Allocated by active receipts <span className="tabular-nums font-medium text-gray-900">{fmtMoney(activeAllocated)}</span>
              <span className="ml-2 text-gray-500">= Paid. Cancelled receipts count ₹0.</span>
            </div>
          )
        }
      />
    </>
  );
}
