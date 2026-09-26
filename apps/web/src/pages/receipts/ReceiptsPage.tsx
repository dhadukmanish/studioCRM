import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ban, Eye, Plus, Printer, RefreshCw } from 'lucide-react';
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, RECEIPT_STATUSES, RECEIPT_STATUS_LABELS, type FilterFieldDef, type ReceiptRow } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Dropdown } from '@/components/ui';
import { useList } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { RECEIPTS_KEY, RECEIPTS_URL } from '@/lib/receipts';
import { CancelReceiptDialog } from './CancelReceiptDialog';
import { ReceiptStatusBadge } from './StatusBadges';

const PERMISSION = 'operations_receipts';

export default function ReceiptsPage() {
  // No sortBy: the API's own order (newest receipt date, then highest receipt number) is the one daily work wants.
  const [state, setState] = useListState();
  const q = useList<ReceiptRow>(RECEIPTS_KEY, RECEIPTS_URL, state);
  const [cancelling, setCancelling] = useState<ReceiptRow | null>(null);
  const nav = useNavigate();
  const can = useAuthStore((s) => s.can);
  const fmt = useDateFormatters();

  const total = q.data?.total ?? 0;
  const canCancel = can(PERMISSION, 'update');
  const filtered = !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'receiptNumber', label: 'Receipt No.', type: 'number' },
    { key: 'receiptDate', label: 'Receipt Date', type: 'date' },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'mobileNumber', label: 'Mobile No.' },
    { key: 'paymentMode', label: 'Payment Mode', type: 'select', options: PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] })) },
    { key: 'accountName', label: 'Account' },
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'status', label: 'Status', type: 'select', options: RECEIPT_STATUSES.map((s) => ({ value: s, label: RECEIPT_STATUS_LABELS[s] })) },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const columns: Column<ReceiptRow>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'receiptNumber', header: 'Receipt No.', render: (r) => <span className="font-medium text-gray-900">{r.receiptNumber}</span> },
    { key: 'receiptDate', header: 'Date', render: (r) => fmt.date(r.receiptDate) },
    { key: 'customerName', header: 'Customer', render: (r) => <span className="block max-w-[200px] truncate" title={r.customerName}>{r.customerName}</span> },
    { key: 'mobileNumber', header: 'Mobile No.', hidden: true },
    { key: 'billNumbers', header: 'Bills', sortable: false, hidden: true, render: (r) => <span className="block max-w-[200px] truncate" title={r.billNumbers}>{r.billNumbers || '-'}</span> },
    { key: 'paymentMode', header: 'Mode', render: (r) => PAYMENT_MODE_LABELS[r.paymentMode] },
    { key: 'accountName', header: 'Account', render: (r) => <span className="block max-w-[180px] truncate" title={r.accountName}>{r.accountName}</span> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      // A cancelled receipt's amount no longer counts anywhere, so it reads as struck through.
      render: (r) => <span className={r.status === 'CANCELLED' ? 'text-gray-400 line-through' : 'font-medium text-gray-900'}>{fmtMoney(r.amount)}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <ReceiptStatusBadge status={r.status} /> },
    { key: 'createdByName', header: 'Created By', sortable: false, render: (r) => r.createdByName || '-' },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmt.stampTime(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Receipts' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Receipts</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'receipt' : 'receipts'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => nav('/modules/receipts/new')}><Plus className="h-4 w-4" /> New Receipt</button>
          )}
        </div>
      </div>

      {q.isError && !q.data && (
        <p className="mb-3 text-[13px] text-red-600">Receipts could not be loaded{q.error instanceof Error ? `: ${q.error.message}` : '.'}</p>
      )}

      <DataTable
        storageKey={RECEIPTS_KEY}
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
        searchPlaceholder="Search by receipt no., customer, mobile or bill no..."
        onRowClick={(r) => nav(`/modules/receipts/${r.id}`)}
        toolbar={filtered ? <button type="button" className="btn-ghost text-primary" onClick={() => setState({ search: '', filters: [], page: 1 })}>Clear</button> : undefined}
        emptyTitle={filtered ? 'No matching receipts' : 'No receipts yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Use New Receipt to record money received against bills.'}
        rowActions={(r) => (
          <Dropdown
            trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for receipt ${r.receiptNumber}`}>…</button>}
            items={[
              { label: 'View', icon: <Eye className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/receipts/${r.id}`) },
              { label: 'Print', icon: <Printer className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/receipts/${r.id}?print=1`) },
              ...(canCancel && r.status === 'ACTIVE' ? [{ label: 'Cancel receipt', icon: <Ban className="h-3.5 w-3.5" />, danger: true, onClick: () => setCancelling(r) }] : []),
            ]}
          />
        )}
      />

      <CancelReceiptDialog receipt={cancelling} onClose={() => setCancelling(null)} />
    </>
  );
}
