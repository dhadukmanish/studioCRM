import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Download, FileText, HandCoins, Printer, RefreshCw, UserRound, X } from 'lucide-react';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  BILL_PAYMENT_STATUS_LABELS,
  RECEIVABLE_BILL_STATUSES,
  RECEIVABLE_BILL_STATUS_LABELS,
  type AgingBucket,
  type ReceivableBillRow,
  type ReceivableBillStatus,
  type ReceivableCustomerRow,
  type ReceivablesExport,
  type ReceivablesListTotals,
  type ReceivablesOverview,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column, type ListState } from '@/components/data/DataTable';
import { Dropdown, Select, Switch, Tabs } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { receivePaymentHref } from '@/lib/receipts';
import {
  downloadReceivablesCsv,
  fetchAllBills,
  fetchAllCustomers,
  receivableCustomerHref,
  useBillReceivablesReport,
  useCustomerSummaryReport,
  useReceivablesOverview,
  type ReceivablesScope,
} from '@/lib/receivables';
import { BillPaymentStatusBadge } from '@/pages/receipts/StatusBadges';
import { KpiStrip, ScopeBar, overviewKpis, useReportScope, useScopeText } from './reportScope';
import { ReportPrintSheet, type ReportPrintData } from './ReportPrintSheet';

/**
 * Receivables / Outstanding (docs/RECEIVABLES_REPORTS.md): Summary (customer-wise), Outstanding
 * Bills (bill-wise) and Aging, over ONE shared scope — As of, the bill-date range and the Book —
 * so the KPI strip and every tab describe the same bills and reconcile to the paisa.
 *
 * Read-only. Every figure, total and bucket is the server's; sorting, search and pagination run
 * on the server, and totals always cover the whole filtered result, never just the page.
 */
const TABS = [
  { value: 'summary', label: 'Summary' },
  { value: 'bills', label: 'Outstanding Bills' },
  { value: 'aging', label: 'Aging' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export default function ReceivablesPage() {
  const { scope, params, set } = useReportScope();
  const overview = useReceivablesOverview(scope);
  const tab: Tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'summary') as Tab;
  const asOf = overview.data?.asOf ?? scope.asOf ?? '';

  return (
    <>
      <Crumb items={[{ label: 'Reports' }, { label: 'Receivables' }]} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[20px] font-semibold text-gray-900">Receivables</h2>
          <span className="text-[13px] text-gray-500">Age from bill date · derived from bills and active receipts</span>
        </div>
        <button type="button" className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => overview.refetch()}><RefreshCw className="h-4 w-4" /></button>
      </div>

      <ScopeBar asOf={overview.data?.asOf} />
      {overview.isError ? (
        <div className="card mb-3 flex items-center justify-between px-4 py-3 text-[13px] text-gray-600">
          <span>The receivables figures could not be loaded.</span>
          <button type="button" className="btn-outline" onClick={() => overview.refetch()}>Retry</button>
        </div>
      ) : (
        <KpiStrip items={overviewKpis(overview.data)} loading={overview.isFetching && !overview.data} />
      )}

      <Tabs className="mb-3 overflow-y-hidden" value={tab} onChange={(v) => set({ tab: v === 'summary' ? undefined : v, bucket: undefined })} tabs={TABS.map((t) => ({ value: t.value, label: t.label }))} />
      {tab === 'summary' && <SummaryTab scope={scope} asOf={asOf} />}
      {tab === 'bills' && <BillsTab scope={scope} asOf={asOf} />}
      {tab === 'aging' && <AgingTab scope={scope} asOf={asOf} overview={overview.data} bucket={AGING_BUCKETS.find((b) => b === params.get('bucket'))} onBucket={(b) => set({ bucket: b })} />}
    </>
  );
}

/* ------------------------------------------------------------ shared bits -- */

/** Print the WHOLE filtered result: fetch it, render the paper sheet, print, clear. */
function usePrint() {
  const [data, setData] = useState<ReportPrintData | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      window.print();
      setData(null);
    }, 150);
    return () => clearTimeout(t);
  }, [data]);
  const run = async (build: () => Promise<ReportPrintData>) => {
    setBusy(true);
    try {
      setData(await build());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The report could not be prepared for printing');
    } finally {
      setBusy(false);
    }
  };
  return { sheet: data ? <ReportPrintSheet data={data} /> : null, run, busy };
}

function useCsv(report: ReceivablesExport, scope: ReceivablesScope, asOf: string, list: ListState, extra: Record<string, unknown>) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await downloadReceivablesCsv(report, asOf, scope, list, extra);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The CSV could not be exported');
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

function ReportActions({ onPrint, onCsv, printing, exporting }: { onPrint: () => void; onCsv: () => void; printing: boolean; exporting: boolean }) {
  return (
    <>
      <button type="button" className="btn-outline" onClick={onPrint} disabled={printing}><Printer className="h-4 w-4" /> Print</button>
      <button type="button" className="btn-outline" onClick={onCsv} disabled={exporting}><Download className="h-4 w-4" /> CSV</button>
    </>
  );
}

/** The whole filtered result's totals, under the table — never the page's. */
function TotalsBar({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line bg-head px-4 py-2.5 text-[13px] text-gray-600">
      {items.map(([k, v]) => (
        <span key={k}>
          {k} <span className="tabular-nums font-medium text-gray-900">{v}</span>
        </span>
      ))}
    </div>
  );
}

const money = (n: number) => fmtMoney(n);
const Money = ({ n, muted }: { n: number; muted?: boolean }) => <span className={cx('tabular-nums', muted && n === 0 ? 'text-gray-400' : 'text-gray-900')}>{money(n)}</span>;
const Truncated = ({ text, width }: { text: string; width: number }) => (
  <span className="block truncate" style={{ maxWidth: width }} title={text}>{text}</span>
);
const ageText = (days: number | null) => (days === null ? '-' : `${days} ${days === 1 ? 'day' : 'days'}`);

/* ---------------------------------------------------------------- summary -- */

function SummaryTab({ scope, asOf }: { scope: ReceivablesScope; asOf: string }) {
  const [list, setList] = useListState({ limit: 20 });
  const [all, setAll] = useState(false);
  const q = useCustomerSummaryReport(scope, list, { all });
  const nav = useNavigate();
  const fmt = useDateFormatters();
  const caption = useScopeText(scope, asOf);
  const print = usePrint();
  const csv = useCsv('customers', scope, asOf, list, { all: all ? 1 : undefined });
  const t = q.data?.totals;
  const open = (r: ReceivableCustomerRow) => nav(receivableCustomerHref(r.customerKey, scope));

  const columns: Column<ReceivableCustomerRow>[] = [
    { key: 'customerName', header: 'Customer', locked: true, render: (r) => <span className="font-medium text-gray-900"><Truncated text={r.customerName} width={200} /></span> },
    { key: 'mobileNumber', header: 'Mobile' },
    { key: 'totalBilled', header: 'Total Billed', align: 'right', render: (r) => <Money n={r.totalBilled} /> },
    { key: 'totalPaid', header: 'Paid', align: 'right', render: (r) => <Money n={r.totalPaid} muted /> },
    { key: 'totalOutstanding', header: 'Outstanding', align: 'right', render: (r) => <span className="font-medium"><Money n={r.totalOutstanding} muted /></span> },
    { key: 'pendingBills', header: 'Pending', align: 'right' },
    { key: 'oldestPendingAge', header: 'Max Age', render: (r) => (r.oldestPendingDate ? <span title={`Oldest pending bill dated ${fmt.date(r.oldestPendingDate)}`}>{ageText(r.oldestPendingAge)}</span> : <span className="text-gray-400">-</span>) },
  ];

  const printIt = () =>
    print.run(async () => {
      const d = await fetchAllCustomers(scope, list, { all });
      return {
        title: 'Receivables Summary',
        caption: [caption, all ? 'All customers' : 'Customers with outstanding', list.search && `Search "${list.search}"`].filter(Boolean).join(' · '),
        summary: [
          ['Customers', String(d.totals.count)],
          ['Billed', money(d.totals.totalBilled)],
          ['Paid', money(d.totals.totalPaid)],
          ['Outstanding', money(d.totals.totalOutstanding)],
          ['Pending bills', String(d.totals.pendingBills)],
        ].map(([label, value]) => ({ label, value })),
        headers: ['Customer', 'Mobile', 'Total Billed', 'Paid', 'Outstanding', 'Pending Bills', 'Oldest Pending'],
        numeric: [2, 3, 4, 5],
        rows: d.rows.map((r) => [r.customerName, r.mobileNumber, money(r.totalBilled), money(r.totalPaid), money(r.totalOutstanding), String(r.pendingBills), r.oldestPendingDate ? `${ageText(r.oldestPendingAge)} (${fmt.date(r.oldestPendingDate)})` : '-']),
        totals: ['Total', '', money(d.totals.totalBilled), money(d.totals.totalPaid), money(d.totals.totalOutstanding), String(d.totals.pendingBills), ''],
      };
    });

  return (
    <>
      <DataTable
        storageKey="receivables-summary"
        dense
        compact
        columns={columns}
        rows={q.data?.rows ?? []}
        total={q.data?.total ?? 0}
        loading={q.isFetching}
        state={list}
        onStateChange={setList}
        rowKey={(r) => r.customerKey}
        onRowClick={open}
        filterFields={false}
        searchPlaceholder="Search customer, mobile, bill or book..."
        toolbar={<Switch checked={all} onChange={(v) => { setAll(v); setList({ page: 1 }); }} label="Include settled customers" />}
        actions={<ReportActions onPrint={printIt} onCsv={csv.run} printing={print.busy} exporting={csv.busy} />}
        onRefresh={() => q.refetch()}
        emptyTitle={q.isError ? 'The report could not be loaded' : list.search ? 'No matching customers' : 'No outstanding receivables'}
        emptyDescription={q.isError ? <button type="button" className="link" onClick={() => q.refetch()}>Retry</button> : list.search ? 'Try a different search.' : 'No customer has an outstanding balance in this scope.'}
        rowActions={(r) => (
          <button type="button" className="row-action" title="View details" aria-label={`View details for ${r.customerName}`} onClick={() => open(r)}><ChevronRight className="h-4 w-4" /></button>
        )}
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-gray-900">{r.customerName}</span>
              <span className="tabular-nums font-medium text-gray-900">{money(r.totalOutstanding)}</span>
            </div>
            <div className="text-[12px] text-gray-500">{r.mobileNumber} · {r.pendingBills} pending · oldest {ageText(r.oldestPendingAge)}</div>
          </div>
        )}
        footer={t && <TotalsBar items={[[`Totals of the ${t.count} ${t.count === 1 ? 'customer' : 'customers'} listed · Billed`, money(t.totalBilled)], ['Paid', money(t.totalPaid)], ['Outstanding', money(t.totalOutstanding)], ['Pending bills', t.pendingBills]]} />}
      />
      {print.sheet}
    </>
  );
}

/* ------------------------------------------------------- outstanding bills -- */

function billCaption(caption: string, status: ReceivableBillStatus, bucket: AgingBucket | undefined, search: string) {
  return [caption, RECEIVABLE_BILL_STATUS_LABELS[status], bucket && `Age ${AGING_BUCKET_LABELS[bucket]}`, search && `Search "${search}"`].filter(Boolean).join(' · ');
}

function BillsTab({ scope, asOf, bucket: fixedBucket }: { scope: ReceivablesScope; asOf: string; bucket?: AgingBucket }) {
  const [list, setList] = useListState({ limit: 20 });
  const [status, setStatus] = useState<ReceivableBillStatus>('OUTSTANDING');
  const [chosenBucket, setChosenBucket] = useState<AgingBucket | undefined>();
  const bucket = fixedBucket ?? chosenBucket;
  const q = useBillReceivablesReport(scope, list, { status, bucket });
  const nav = useNavigate();
  const fmt = useDateFormatters();
  const can = useAuthStore((s) => s.can);
  const canBill = can('operations_billing', 'read');
  const canReceive = can('operations_receipts', 'create');
  const caption = useScopeText(scope, asOf);
  const print = usePrint();
  const csv = useCsv('bills', scope, asOf, list, { status, bucket });
  const t = q.data?.totals;
  useEffect(() => setList({ page: 1 }), [fixedBucket]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: Column<ReceivableBillRow>[] = [
    /**
     * Book and number in one cell (sorted by book, then number), long books cut with an ellipsis. With Mobile and
     * Paid hidden by default (one click away in Columns; Paid = Grand Total − Outstanding, and it is in the totals
     * row), Outstanding, Payment, Age and Actions fit a 1280px screen. Measured: all ten needed ~1,260px of 976.
     */
    { key: 'billNumber', header: 'Bill', render: (r) => <span className="flex max-w-[150px] font-medium text-gray-900" title={`${r.bookNumber}/${r.billNumber}`}><span className="truncate">{r.bookNumber}</span>/{r.billNumber}</span> },
    { key: 'billDate', header: 'Bill Date', render: (r) => fmt.date(r.billDate) },
    { key: 'customerName', header: 'Customer', render: (r) => <Truncated text={r.customerName} width={170} /> },
    { key: 'mobileNumber', header: 'Mobile', hidden: true },
    { key: 'grandTotal', header: 'Grand Total', align: 'right', render: (r) => <Money n={r.grandTotal} /> },
    { key: 'paidAmount', header: 'Paid', align: 'right', hidden: true, render: (r) => <Money n={r.paidAmount} muted /> },
    { key: 'outstandingAmount', header: 'Outstanding', align: 'right', render: (r) => <span className="font-medium"><Money n={r.outstandingAmount} muted /></span> },
    { key: 'paymentStatus', header: 'Payment', render: (r) => <BillPaymentStatusBadge status={r.paymentStatus} /> },
    { key: 'ageDays', header: 'Age', align: 'right', render: (r) => <span title={AGING_BUCKET_LABELS[r.agingBucket]}>{ageText(r.ageDays)}</span> },
  ];

  const printIt = () =>
    print.run(async () => {
      const d = await fetchAllBills(scope, list, { status, bucket });
      return {
        title: bucket ? `Receivables Aging — ${AGING_BUCKET_LABELS[bucket]}` : 'Outstanding Bills',
        caption: billCaption(caption, status, bucket, list.search),
        summary: totalsSummary(d.totals, 'Bills'),
        headers: ['Book', 'Bill No.', 'Bill Date', 'Customer', 'Mobile', 'Grand Total', 'Paid', 'Outstanding', 'Payment', 'Age (days)'],
        numeric: [1, 5, 6, 7, 9],
        rows: d.rows.map((r) => [r.bookNumber, String(r.billNumber), fmt.date(r.billDate), r.customerName, r.mobileNumber, money(r.grandTotal), money(r.paidAmount), money(r.outstandingAmount), BILL_PAYMENT_STATUS_LABELS[r.paymentStatus], String(r.ageDays)]),
        totals: ['Total', '', '', `${d.totals.count} bills`, '', money(d.totals.totalBilled), money(d.totals.totalPaid), money(d.totals.totalOutstanding), '', ''],
        landscape: true,
      };
    });

  return (
    <>
      <DataTable
        storageKey="receivables-bills"
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
        onRowClick={canBill ? (r) => nav(`/modules/billing/${r.id}`) : undefined}
        filterFields={false}
        searchPlaceholder="Search bill no., customer, mobile or book..."
        toolbar={
          <>
            <Select size="sm" className="w-[150px]" value={status} placeholder="Status" onChange={(v) => { setStatus((v || 'OUTSTANDING') as ReceivableBillStatus); setList({ page: 1 }); }} options={RECEIVABLE_BILL_STATUSES.map((s) => ({ value: s, label: RECEIVABLE_BILL_STATUS_LABELS[s] }))} />
            {!fixedBucket && <Select size="sm" className="w-[130px]" value={chosenBucket ?? ''} placeholder="Any age" onChange={(v) => { setChosenBucket((v || undefined) as AgingBucket | undefined); setList({ page: 1 }); }} options={AGING_BUCKETS.map((b) => ({ value: b, label: AGING_BUCKET_LABELS[b] }))} />}
          </>
        }
        actions={<ReportActions onPrint={printIt} onCsv={csv.run} printing={print.busy} exporting={csv.busy} />}
        onRefresh={() => q.refetch()}
        emptyTitle={q.isError ? 'The report could not be loaded' : 'No bills match the selected filters'}
        emptyDescription={q.isError ? <button type="button" className="link" onClick={() => q.refetch()}>Retry</button> : status === 'OUTSTANDING' ? 'Nothing is outstanding in this scope.' : 'Try another status, age or search.'}
        rowActions={(r) => (
          <Dropdown
            trigger={<button type="button" className="row-action" title="Actions" aria-label={`Actions for bill ${r.bookNumber}/${r.billNumber}`}>…</button>}
            items={[
              ...(canBill ? [{ label: 'View bill', icon: <FileText className="h-3.5 w-3.5" />, onClick: () => nav(`/modules/billing/${r.id}`) }] : []),
              { label: 'Customer details', icon: <UserRound className="h-3.5 w-3.5" />, onClick: () => nav(receivableCustomerHref(r.customerKey, scope)) },
              ...(canReceive && r.outstandingAmount > 0 ? [{ label: 'Receive payment', icon: <HandCoins className="h-3.5 w-3.5" />, onClick: () => nav(receivePaymentHref(r.customerKey, r.id)) }] : []),
            ]}
          />
        )}
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium text-gray-900">{r.bookNumber}/{r.billNumber} · {r.customerName}</span>
              <span className="tabular-nums font-medium text-gray-900">{money(r.outstandingAmount)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[12px] text-gray-500">
              <BillPaymentStatusBadge status={r.paymentStatus} />
              <span>{fmt.date(r.billDate)} · {ageText(r.ageDays)}</span>
            </div>
          </div>
        )}
        footer={t && <TotalsBar items={[[`Totals of the ${t.count} ${t.count === 1 ? 'bill' : 'bills'} listed · Billed`, money(t.totalBilled)], ['Paid', money(t.totalPaid)], ['Outstanding', money(t.totalOutstanding)]]} />}
      />
      {print.sheet}
    </>
  );
}

const totalsSummary = (t: ReceivablesListTotals, countLabel: string) =>
  [
    [countLabel, String(t.count)],
    ['Billed', money(t.totalBilled)],
    ['Paid', money(t.totalPaid)],
    ['Outstanding', money(t.totalOutstanding)],
  ].map(([label, value]) => ({ label, value }));

/* ------------------------------------------------------------------- aging -- */

function AgingTab({ scope, asOf, overview, bucket, onBucket }: { scope: ReceivablesScope; asOf: string; overview?: ReceivablesOverview; bucket?: AgingBucket; onBucket: (b: AgingBucket | undefined) => void }) {
  const [list, setList] = useListState({ limit: 20 });
  const q = useCustomerSummaryReport(scope, list, {});
  const nav = useNavigate();
  const fmt = useDateFormatters();
  const caption = useScopeText(scope, asOf);
  const print = usePrint();
  const csv = useCsv('aging', scope, asOf, list, {});
  const t = q.data?.totals;

  const columns: Column<ReceivableCustomerRow>[] = [
    { key: 'customerName', header: 'Customer', locked: true, render: (r) => <span className="font-medium text-gray-900"><Truncated text={r.customerName} width={200} /></span> },
    { key: 'mobileNumber', header: 'Mobile', hidden: true },
    ...AGING_BUCKETS.map((b): Column<ReceivableCustomerRow> => ({ key: `aging.${b}`, header: AGING_BUCKET_LABELS[b], align: 'right', render: (r) => <Money n={r.aging[b]} muted /> })),
    { key: 'totalOutstanding', header: 'Total', align: 'right', render: (r) => <span className="font-medium"><Money n={r.totalOutstanding} /></span> },
  ];

  const printIt = () =>
    print.run(async () => {
      const d = await fetchAllCustomers(scope, list, {});
      return {
        title: 'Receivables Aging',
        caption: [caption, 'Age from bill date', list.search && `Search "${list.search}"`].filter(Boolean).join(' · '),
        summary: [...AGING_BUCKETS.map((b) => ({ label: AGING_BUCKET_LABELS[b], value: money(d.totals.aging[b]) })), { label: 'Total Outstanding', value: money(d.totals.totalOutstanding) }],
        headers: ['Customer', 'Mobile', ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABELS[b]), 'Total'],
        numeric: [2, 3, 4, 5, 6, 7],
        rows: d.rows.map((r) => [r.customerName, r.mobileNumber, ...AGING_BUCKETS.map((b) => money(r.aging[b])), money(r.totalOutstanding)]),
        totals: ['Total', `${d.totals.count} customers`, ...AGING_BUCKETS.map((b) => money(d.totals.aging[b])), money(d.totals.totalOutstanding)],
        landscape: true,
      };
    });

  return (
    <>
      {/* Bucket strip: the SCOPE's buckets (the KPI strip's figures — the table's search never narrows them), so it
          always matches the bills a bucket lists. The five add up to the Total. Selecting one lists that bucket's bills. */}
      <div className="card mb-3 grid grid-cols-3 overflow-hidden sm:grid-cols-6" role="group" aria-label="Aging buckets">
        {AGING_BUCKETS.map((b, i) => (
          <button
            key={b}
            type="button"
            aria-pressed={bucket === b}
            onClick={() => onBucket(bucket === b ? undefined : b)}
            className={cx('px-4 py-2.5 text-left transition hover:bg-gray-50', i > 0 && 'border-l border-line', i >= 3 && 'border-t border-line sm:border-t-0', i === 3 && 'border-l-0 sm:border-l', bucket === b && 'bg-primary-lighter/40 hover:bg-primary-lighter/40')}
          >
            <div className={cx('text-[12px]', bucket === b ? 'text-primary' : 'text-gray-500')}>{AGING_BUCKET_LABELS[b]}</div>
            <div className="tabular-nums text-[15px] text-gray-900">{money(overview?.aging[b] ?? 0)}</div>
          </button>
        ))}
        <div className="border-l border-t border-line px-4 py-2.5 sm:border-t-0">
          <div className="text-[12px] text-gray-500">Total Outstanding</div>
          <div className="tabular-nums text-[15px] font-semibold text-gray-900">{money(overview?.totalOutstanding ?? 0)}</div>
        </div>
      </div>

      {bucket ? (
        <>
          <div className="mb-2 flex items-center gap-2 text-[13px] text-gray-600">
            <span>Bills aged <b className="font-medium text-gray-900">{AGING_BUCKET_LABELS[bucket]}</b></span>
            <button type="button" className="btn-ghost text-primary" onClick={() => onBucket(undefined)}><X className="h-3.5 w-3.5" /> All buckets</button>
          </div>
          <BillsTab scope={scope} asOf={asOf} bucket={bucket} />
        </>
      ) : (
        <DataTable
          storageKey="receivables-aging"
          dense
          compact
          columns={columns}
          rows={q.data?.rows ?? []}
          total={q.data?.total ?? 0}
          loading={q.isFetching}
          state={list}
          onStateChange={setList}
          rowKey={(r) => r.customerKey}
          onRowClick={(r) => nav(receivableCustomerHref(r.customerKey, scope))}
          filterFields={false}
          searchPlaceholder="Search customer, mobile, bill or book..."
          actions={<ReportActions onPrint={printIt} onCsv={csv.run} printing={print.busy} exporting={csv.busy} />}
          onRefresh={() => q.refetch()}
          emptyTitle={q.isError ? 'The report could not be loaded' : 'No outstanding receivables'}
          emptyDescription={q.isError ? <button type="button" className="link" onClick={() => q.refetch()}>Retry</button> : 'Nothing is outstanding in this scope.'}
          mobileCard={(r) => (
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-gray-900">{r.customerName}</span>
                <span className="tabular-nums font-medium text-gray-900">{money(r.totalOutstanding)}</span>
              </div>
              <div className="text-[12px] text-gray-500">
                {AGING_BUCKETS.filter((b) => r.aging[b] > 0).map((b) => `${AGING_BUCKET_LABELS[b]} ${money(r.aging[b])}`).join(' · ')}
              </div>
            </div>
          )}
          footer={t && <TotalsBar items={[[`${t.count} ${t.count === 1 ? 'customer' : 'customers'} · Outstanding`, money(t.totalOutstanding)], ...AGING_BUCKETS.map((b): [string, ReactNode] => [AGING_BUCKET_LABELS[b], money(t.aging[b])])]} />}
        />
      )}
      {print.sheet}
    </>
  );
}
