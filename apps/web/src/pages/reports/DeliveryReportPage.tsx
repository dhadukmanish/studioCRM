import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PackageCheck, RefreshCw } from 'lucide-react';
import {
  BILL_PAYMENT_STATUS_LABELS,
  DELIVERY_VIEWS,
  DELIVERY_VIEW_LABELS,
  WORK_POSITION_LABELS,
  type DeliveryReportRow,
  type DeliveryView,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column } from '@/components/data/DataTable';
import { Badge } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { downloadDeliveryCsv, fetchAllDeliveries, useDeliveryReport, useWorkActions, type DeliveryFilters } from '@/lib/work';
import { BillPaymentStatusBadge } from '@/pages/receipts/StatusBadges';
import { DateRange, ReportActions, ViewChips, rangeText, useBusyAction, useReportPrint } from './reportKit';

/**
 * Reports -> Delivery (docs/STUDIO_WORKFLOW.md): which jobs still have to be handed over, which
 * are due or overdue against the promised Delivery Date, and which were delivered. Every view,
 * count, stage and money figure is the server's. Delivered never means paid — Payment and
 * Outstanding stay visible on delivered rows too.
 */
const EMPTY: Record<DeliveryView, string> = {
  PENDING: 'No deliveries pending.',
  DUE_TODAY: 'Nothing is due for delivery today.',
  OVERDUE: 'No overdue deliveries.',
  DELIVERED: 'No deliveries recorded yet.',
  ALL: 'No bills yet.',
};
const DASH = '—';

export default function DeliveryReportPage() {
  const [list, setList] = useListState({ limit: 20 });
  const [f, setF] = useState<DeliveryFilters>({ view: 'PENDING' });
  const q = useDeliveryReport(f, list);
  const fmt = useDateFormatters();
  const can = useAuthStore((s) => s.can);
  const canBill = can('operations_billing', 'read');
  // Money only for someone who may see Billing or Receipts — the server sends none otherwise.
  const seesMoney = canBill || can('operations_receipts', 'read');
  const canDeliver = can('operations_work', 'update');
  const act = useWorkActions();
  const print = useReportPrint();
  const csv = useBusyAction('The CSV could not be exported');
  const today = q.data?.today ?? '';
  const filtered = !!list.search || !!f.from || !!f.to;
  const change = (p: Partial<DeliveryFilters>) => { setF((s) => ({ ...s, ...p })); setList({ page: 1 }); };

  const billRef = (r: DeliveryReportRow) => `${r.bookNumber}/${r.billNumber}`;
  const overdue = (r: DeliveryReportRow) => !!r.plannedDelivery && !!today && r.plannedDelivery < today && r.deliveryOutcome === null;
  const stage = (r: DeliveryReportRow) => (r.deliveryOutcome === 'SKIPPED' ? 'Not needed' : WORK_POSITION_LABELS[r.position]);
  const planned = (r: DeliveryReportRow) =>
    r.plannedDelivery ? (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        {fmt.date(r.plannedDelivery)}
        {overdue(r) && <Badge color="red">Overdue</Badge>}
      </span>
    ) : (
      <span className="text-gray-400">{DASH}</span>
    );

  const baseColumns: Column<DeliveryReportRow>[] = [
    {
      key: 'billNumber',
      header: 'Bill',
      locked: true,
      render: (r) =>
        canBill ? (
          <Link to={`/modules/billing/${r.id}`} className="link block max-w-[150px] truncate" title={billRef(r)}>{billRef(r)}</Link>
        ) : (
          <span className="block max-w-[150px] truncate font-medium text-gray-900" title={billRef(r)}>{billRef(r)}</span>
        ),
    },
    { key: 'billDate', header: 'Bill Date', render: (r) => fmt.date(r.billDate) },
    { key: 'customerName', header: 'Customer', render: (r) => <span className="block max-w-[170px] truncate" title={r.customerName}>{r.customerName}</span> },
    { key: 'mobileNumber', header: 'Mobile' },
    { key: 'babyName', header: 'Baby', hidden: true, render: (r) => r.babyName || DASH },
    { key: 'plannedDelivery', header: 'Planned Delivery', render: planned },
    { key: 'position', header: 'Stage', render: stage },
    { key: 'deliveredOn', header: 'Delivered On', render: (r) => (r.deliveredOn ? fmt.date(r.deliveredOn) : <span className="text-gray-400">{DASH}</span>) },
    ...(seesMoney
      ? ([
          { key: 'paymentStatus', header: 'Payment', render: (r) => r.paymentStatus && <BillPaymentStatusBadge status={r.paymentStatus} /> },
          { key: 'outstandingAmount', header: 'Outstanding', align: 'right', render: (r) => <span className={cx('tabular-nums', r.outstandingAmount === 0 ? 'text-gray-400' : 'text-gray-900')}>{fmtMoney(r.outstandingAmount ?? 0)}</span> },
        ] satisfies Column<DeliveryReportRow>[])
      : []),
  ];
  const columns = baseColumns.map((c) => ({ ...c, sortable: false })); // the report's order is the server's

  const caption = () =>
    [DELIVERY_VIEW_LABELS[f.view], rangeText('Bill date', f.from, f.to, fmt.date), list.search && `Search "${list.search}"`].filter(Boolean).join(' · ');

  const printIt = () =>
    print.run(async () => {
      const d = await fetchAllDeliveries(f, list);
      return {
        title: 'Delivery Report',
        caption: caption(),
        summary: [{ label: 'Bills', value: String(d.total) }],
        headers: ['Bill', 'Bill Date', 'Customer', 'Mobile', 'Baby', 'Planned Delivery', 'Stage', 'Delivered On', ...(seesMoney ? ['Payment', 'Outstanding'] : [])],
        numeric: seesMoney ? [9] : [],
        rows: d.rows.map((r) => [
          billRef(r),
          fmt.date(r.billDate),
          r.customerName,
          r.mobileNumber,
          r.babyName || DASH,
          r.plannedDelivery ? `${fmt.date(r.plannedDelivery)}${r.plannedDelivery < d.today && r.deliveryOutcome === null ? ' (Overdue)' : ''}` : DASH,
          stage(r),
          r.deliveredOn ? fmt.date(r.deliveredOn) : DASH,
          ...(seesMoney ? [r.paymentStatus ? BILL_PAYMENT_STATUS_LABELS[r.paymentStatus] : '', fmtMoney(r.outstandingAmount ?? 0)] : []),
        ]),
        totals: [`${d.total} ${d.total === 1 ? 'bill' : 'bills'}`, '', '', '', '', '', '', '', ...(seesMoney ? ['', ''] : [])],
        landscape: true,
      };
    });

  const deliverButton = (r: DeliveryReportRow) =>
    canDeliver && r.deliveryOutcome === null ? (
      <button
        type="button"
        className="btn-outline-primary h-7 px-2.5 text-[13px] max-sm:h-9"
        disabled={act.isPending && act.variables?.type === 'record' && act.variables.billId === r.id}
        aria-label={`Mark bill ${billRef(r)} delivered`}
        onClick={() => act.mutate({ type: 'record', billId: r.id, stage: 'DELIVERY' })}
      >
        <PackageCheck className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Mark Delivered
      </button>
    ) : null;

  return (
    <>
      <Crumb items={[{ label: 'Reports' }, { label: 'Delivery' }]} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Delivery</h2>
          <span className="text-[13px] text-gray-500">Planned from the bill's Delivery Date · delivered never means paid</span>
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => q.refetch()}><RefreshCw className="h-4 w-4" /></button>
      </div>

      <ViewChips label="Delivery view" views={DELIVERY_VIEWS} labels={DELIVERY_VIEW_LABELS} counts={q.data?.counts} value={f.view} onChange={(view) => change({ view })} />

      <DataTable
        storageKey="delivery-report"
        columnsButton
        dense
        compact
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isFetching}
        state={list}
        onStateChange={setList}
        rowKey={(r) => r.id}
        filterFields={false}
        searchPlaceholder="Search bill no., customer or mobile..."
        toolbar={<DateRange label="Bill date" from={f.from} to={f.to} onChange={(r) => change(r)} />}
        actions={<ReportActions onPrint={printIt} onCsv={() => csv.run(() => downloadDeliveryCsv(f, list, today))} printing={print.busy} exporting={csv.busy} />}
        onRefresh={() => q.refetch()}
        emptyTitle={q.isError ? 'The report could not be loaded' : filtered ? 'No matching bills' : EMPTY[f.view]}
        emptyDescription={
          q.isError ? (
            <>
              {q.error instanceof ApiError && <span className="block">{q.error.message}</span>}
              <button type="button" className="link" onClick={() => q.refetch()}>Retry</button>
            </>
          ) : filtered ? 'Try a different search or date range.' : undefined
        }
        rowActions={deliverButton}
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-gray-900">{billRef(r)} · {r.customerName}</span>
              {seesMoney && <span className={cx('tabular-nums', r.outstandingAmount === 0 ? 'text-gray-400' : 'font-medium text-gray-900')}>{fmtMoney(r.outstandingAmount ?? 0)}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-gray-500">
              {r.paymentStatus && <BillPaymentStatusBadge status={r.paymentStatus} />}
              <span>{stage(r)}</span>
              {r.deliveredOn ? <span>Delivered {fmt.date(r.deliveredOn)}</span> : r.plannedDelivery && <span className="inline-flex items-center gap-1">Due {planned(r)}</span>}
            </div>
          </div>
        )}
      />
      {print.sheet}
    </>
  );
}

