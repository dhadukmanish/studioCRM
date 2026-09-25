import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileText, MessageCircle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { BILL_DISCOUNT_TYPES, BILL_DISCOUNT_TYPE_LABELS, INVOICE_TAX_MODES, INVOICE_TAX_MODE_LABELS, invoiceFileName, type FilterFieldDef } from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge, ConfirmDialog, Dropdown } from '@/components/ui';
import { useList, useSave } from '@/lib/queries';
import { useAuthStore } from '@/store/auth';
import { fmtMoney, fmtNum } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { downloadInvoicePdf } from '@/lib/invoice';
import { ShareInvoiceDialog } from '@/components/invoice/ShareInvoiceDialog';
import { toast } from '@/lib/toast';
import { ApiError } from '@/lib/api';
import type { BillRow } from './types';

const PERMISSION = 'operations_billing';
const URL = '/api/bills';
const QUERY_KEY = 'bills';

export default function BillsPage() {
  // No sortBy: the API's own order (latest bill date, then highest bill number) is the one
  // daily work wants, and it cannot be expressed as a single column.
  const [state, setState] = useListState();
  const q = useList<BillRow>(QUERY_KEY, URL, state);
  const [del, setDel] = useState<BillRow | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const nav = useNavigate();
  const can = useAuthStore((s) => s.can);
  const remove = useSave({ invalidate: [QUERY_KEY, 'bill-invoice'], onSuccess: () => setDel(null) });

  const total = q.data?.total ?? 0;
  const canEdit = can(PERMISSION, 'update');
  const canDelete = can(PERMISSION, 'delete');
  const filtered = !!state.search || state.filters.length > 0;

  const filterFields: FilterFieldDef[] = [
    { key: 'bookNumber', label: 'Book Number' },
    { key: 'billDate', label: 'Bill Date', type: 'date' },
    { key: 'billNumber', label: 'Bill No.', type: 'number' },
    { key: 'taxMode', label: 'Tax Mode', type: 'select', options: INVOICE_TAX_MODES.map((m) => ({ value: m, label: INVOICE_TAX_MODE_LABELS[m] })) },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'mobileNumber', label: 'Mobile No.' },
    { key: 'grandTotal', label: 'Grand Total', type: 'number' },
    { key: 'discountType', label: 'Discount Type', type: 'select', options: BILL_DISCOUNT_TYPES.map((t) => ({ value: t, label: BILL_DISCOUNT_TYPE_LABELS[t] })) },
    { key: 'updatedAt', label: 'Last Modified', type: 'date' },
    { key: 'createdAt', label: 'Created At', type: 'date' },
  ];

  const fmt = useDateFormatters();


  const columns: Column<BillRow>[] = [
    { key: '_seq', header: '#', sortable: false, width: 56, locked: true, render: (_r, i) => <span className="text-gray-500">{(state.page - 1) * state.limit + i + 1}</span> },
    { key: 'bookNumber', header: 'Book' },
    { key: 'billNumber', header: 'Bill No.', render: (r) => <span className="font-medium text-gray-900">{r.billNumber}</span> },
    { key: 'billDate', header: 'Bill Date', render: (r) => fmt.date(r.billDate) },
    { key: 'customerName', header: 'Customer Name' },
    { key: 'mobileNumber', header: 'Mobile No.' },
    { key: 'deliveryDate', header: 'Delivery Date', render: (r) => fmt.date(r.deliveryDate) },
    /** Text in the badge, never colour alone — the two modes must read the same to everyone. */
    { key: 'taxMode', header: 'Tax Mode', render: (r) => <Badge color={r.taxMode === 'WITH_GST' ? 'blue' : 'gray'}>{INVOICE_TAX_MODE_LABELS[r.taxMode]}</Badge> },
    { key: 'grandTotal', header: 'Grand Total', align: 'right', render: (r) => <span className="font-medium text-gray-900">{fmtMoney(r.grandTotal)}</span> },
    /** Hidden by default: useful when reconciling, but they would push the row past the viewport. */
    { key: 'subTotal', header: 'Sub Total', align: 'right', hidden: true, render: (r) => fmtMoney(r.subTotal) },
    /** Shows WHAT was given as well as how much — "10%" and "₹1,000" are not the same fact. */
    {
      key: 'discountAmount',
      header: 'Discount',
      align: 'right',
      hidden: true,
      render: (r) =>
        r.discountType === 'NONE' ? (
          <span className="text-gray-400">-</span>
        ) : (
          <span>
            {fmtMoney(r.discountAmount)}
            {r.discountType === 'PERCENT' && <span className="ml-1 text-gray-500">({fmtNum(r.discountValue)}%)</span>}
          </span>
        ),
    },
    { key: 'gstAmount', header: 'GST Amount', align: 'right', hidden: true, render: (r) => fmtMoney(r.gstAmount) },
    { key: 'babyName', header: 'Baby Name', hidden: true, render: (r) => r.babyName || '-' },
    { key: 'remark', header: 'Remark', hidden: true, render: (r) => r.remark || '-' },
    { key: 'updatedAt', header: 'Last Modified', render: (r) => fmt.stamp(r.updatedAt) },
    { key: 'createdAt', header: 'Created At', hidden: true, render: (r) => fmt.stamp(r.createdAt) },
  ];

  return (
    <>
      <Crumb items={[{ label: 'Operations' }, { label: 'Billing' }]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Bills</h2>
          <span className="text-[13px] text-gray-500">{total} {total === 1 ? 'bill' : 'bills'}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
          {can(PERMISSION, 'create') && (
            <button type="button" className="btn-primary" onClick={() => nav('/modules/billing/new')}><Plus className="h-4 w-4" /> New Bill</button>
          )}
        </div>
      </div>

      <DataTable
        storageKey={QUERY_KEY}
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
        searchPlaceholder="Search by bill no., customer, mobile or book..."
        // Read access is enough to OPEN a bill: the form renders view-only without update.
        onRowClick={(r) => nav(`/modules/billing/${r.id}`)}
        toolbar={filtered ? <button type="button" className="btn-ghost text-primary" onClick={() => setState({ search: '', filters: [], page: 1 })}>Clear</button> : undefined}
        emptyTitle={filtered ? 'No matching bills' : 'No bills yet'}
        emptyDescription={filtered ? 'Try a different search or clear the filters.' : 'Use New Bill to raise the first one.'}
        rowActions={(r) => (
          <Dropdown
            trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for bill ${r.bookNumber}/${r.billNumber}`}>…</button>}
            items={[
              /* Read is enough to open a bill; the form itself is view-only without update. */
              { label: canEdit ? 'Edit' : 'View', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/billing/${r.id}`) },
              { label: 'Preview invoice', icon: <FileText className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/billing/${r.id}/invoice`) },
              { label: 'Share on WhatsApp', icon: <MessageCircle className="h-3.5 w-3.5" />, onClick: () => setShareId(r.id) },
              { label: 'Download PDF', icon: <Download className="h-3.5 w-3.5" />, onClick: () => downloadInvoicePdf(r.id, invoiceFileName(r.bookNumber, r.billNumber)).catch((e) => toast.error(e instanceof ApiError ? e.message : 'The PDF could not be generated')) },
              ...(canDelete ? [{ label: 'Delete', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setDel(r) }] : []),
            ]}
          />
        )}
      />

      <ShareInvoiceDialog billId={shareId} open={!!shareId} onClose={() => setShareId(null)} />

      <ConfirmDialog
        open={!!del}
        onClose={() => setDel(null)}
        loading={remove.isPending}
        title="Delete bill?"
        message={
          <>
            Delete bill <b>{del?.bookNumber}/{del?.billNumber}</b> for <b>"{del?.customerName}"</b>? This cannot be undone, and the bill number is not reissued.
          </>
        }
        onConfirm={() => del && remove.mutate({ method: 'delete', url: `${URL}/${del.id}` })}
      />
    </>
  );
}
