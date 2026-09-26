import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BILL_REPORT_TABS,
  BILL_REPORT_TAB_LABELS,
  INVOICE_TAX_MODE_LABELS,
  type BillDetailRow,
  type BillDetailTotals,
  type BillReportTab,
  type BillReportTotals,
  type BillSummaryRow,
} from '@erp/shared';
import { Crumb } from '@/components/layout/AppShell';
import { DataTable, useListState, type Column, type ListState } from '@/components/data/DataTable';
import { Tabs } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useAuthStore } from '@/store/auth';
import { downloadBillReportCsv, fetchWholeBillReport, useBillReport, type BillReportScope } from '@/lib/billReport';
import { BillPaymentStatusBadge } from '@/pages/receipts/StatusBadges';
import { BillReportFilterBar, useBillReportCaption, useBillReportScope } from './BillReportFilters';
import { ReportActions, useBusyAction, useReportPrint } from './reportKit';
import type { ReportPrintData } from './ReportPrintSheet';

/**
 * Reports -> Bill Summary (docs/BILL_SUMMARY_REPORT.md) — the legacy Bill Summary Report: From / To
 * date and Customer, and the bills' Sub Total, Discount, Advance / Received and Grand Total. ONE screen, ONE
 * scope, two tabs: Summary (a row per bill) and Detailed (a row per bill item). Every row and total
 * is the server's, and the totals always cover the whole filtered result, never just the page.
 */
const DASH = '—';
const ADVANCE = 'Advance / Received';
/** The longest header wraps to two lines ("Advance /" over "Received") instead of widening the table. */
const ADVANCE_HEAD = '!whitespace-normal w-[104px] leading-tight';
const ADVANCE_HINT = 'Advance / Received includes payments received or applied against the bill. Unapplied customer advance is excluded.';

const Money = ({ n, muted = true }: { n: number | null; muted?: boolean }) =>
  n === null ? null : <span className={cx('tabular-nums', muted && n === 0 ? 'text-gray-400' : 'text-gray-900')}>{fmtMoney(n)}</span>;
const Truncated = ({ text, width }: { text: string; width: number }) => (
  <span className="block truncate" style={{ maxWidth: width }} title={text}>{text}</span>
);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;

export default function BillReportPage() {
  const { scope, tab, search, set } = useBillReportScope();
  // One list state for both tabs: the search and the (bill-level) sort survive a tab switch.
  const [list, setList] = useListState({ limit: 20, sortOrder: 'asc', search });
  // A new scope starts at page 1 — never "page 4 of a customer who has 3 bills".
  const scopeKey = JSON.stringify(scope);
  useEffect(() => setList({ page: 1 }), [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The search is part of the scope, so it lives in the URL too (Back / reload / bookmark keep it).
  useEffect(() => { if ((list.search || undefined) !== search) set({ q: list.search || undefined }); }, [list.search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Crumb items={[{ label: 'Reports' }, { label: 'Bill Summary' }]} />
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[20px] font-semibold text-gray-900">Bill Summary Report</h2>
        <span className="text-[13px] text-gray-500">Saved bill figures</span>
      </div>
      <Tabs
        className="mb-3 overflow-y-hidden"
        value={tab}
        onChange={(v) => { set({ tab: v === 'summary' ? undefined : v }); setList({ page: 1 }); }}
        tabs={BILL_REPORT_TABS.map((t) => ({ value: t, label: BILL_REPORT_TAB_LABELS[t] }))}
      />
      {tab === 'summary' ? <SummaryTab scope={scope} list={list} setList={setList} onClearAll={() => clearAll(set, setList)} /> : <DetailedTab scope={scope} list={list} setList={setList} onClearAll={() => clearAll(set, setList)} />}
    </>
  );
}

function clearAll(set: (p: Record<string, string | undefined>) => void, setList: (p: Partial<ListState>) => void) {
  set({ from: undefined, to: undefined, customer: undefined, book: undefined, series: undefined, billNo: undefined, payment: undefined, q: undefined });
  setList({ search: '', page: 1 });
}

interface TabProps {
  scope: BillReportScope;
  list: ListState;
  setList: (p: Partial<ListState>) => void;
  onClearAll: () => void;
}

/** What both tabs share around their table: filters, empty / error text, whole-result print, preview and CSV. */
function useReportShell<T extends BillReportTab>(tab: T, { scope, list }: TabProps) {
  const q = useBillReport(tab, scope, list);
  const resolved = q.data ? { from: q.data.from, to: q.data.to } : undefined;
  const caption = useBillReportCaption(resolved, list.search);
  const print = useReportPrint();
  const csv = useBusyAction('The CSV could not be exported');
  const narrowed = !!(scope.customer || scope.bookId || scope.seriesType || scope.billNumber || scope.paymentStatus || list.search);
  const range = [q.data?.from, q.data?.to].filter(Boolean).join('-to-') || 'all';
  const empty = {
    emptyTitle: q.isError ? 'The report could not be loaded' : narrowed ? 'No bills match these filters.' : 'No bills found for this period.',
    emptyDescription: q.isError ? (
      <>
        {q.error instanceof ApiError && <span className="block">{q.error.message}</span>}
        <button type="button" className="link" onClick={() => q.refetch()}>Retry</button>
      </>
    ) : (
      'Change the dates or filters above.'
    ),
  };
  const actions = (build: () => Promise<ReportPrintData>) => (
    <>
      <ReportActions
        onPreview={() => print.run(build, 'preview')}
        onPrint={() => print.run(build)}
        onCsv={() => csv.run(() => downloadBillReportCsv(tab, scope, list, range))}
        printing={print.busy}
        previewing={print.previewing}
        exporting={csv.busy}
      />
    </>
  );
  return { q, resolved, caption, print, empty, actions };
}

/** The whole result's totals as a strip — the phone's totals — and the one Advance / Received note. */
function TotalsNote({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="border-t border-line bg-head px-4 py-2.5 text-[13px] text-gray-600">
      {items.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-x-5 gap-y-1 sm:hidden">
          {items.map(([k, v]) => (
            <span key={k}>
              {k} <span className="font-medium tabular-nums text-gray-900">{v}</span>
            </span>
          ))}
        </div>
      )}
      <p className="text-[12px] text-gray-500">{ADVANCE_HINT}</p>
    </div>
  );
}

/** The legacy report's four primary totals, in its order. GST stays a table column, not a primary total. */
const totalItems = (t: BillReportTotals): [string, ReactNode][] => [
  ['Bills', t.bills],
  ['Sub Total', fmtMoney(t.subTotal)],
  ['Discount', fmtMoney(t.discount)],
  [ADVANCE, fmtMoney(t.advance)],
  ['Grand Total', fmtMoney(t.grandTotal)],
];
const printSummary = (t: BillReportTotals) => totalItems(t).map(([label, value]) => ({ label, value: String(value) }));

/* ---------------------------------------------------------------- summary -- */

function SummaryTab(props: TabProps) {
  const { list, setList } = props;
  const { q, resolved, caption, print, empty, actions } = useReportShell('summary', props);
  const fmt = useDateFormatters();
  const canBill = useAuthStore((s) => s.can)('operations_billing');
  const t = q.data?.totals;

  const columns: Column<BillSummaryRow>[] = [
    { key: 'bookNumber', header: 'Book No.', locked: true, render: (r) => <Truncated text={r.bookNumber} width={86} /> },
    {
      key: 'billNumber',
      header: 'Bill No.',
      render: (r) => (canBill ? <Link to={`/modules/billing/${r.id}`} className="link tabular-nums" aria-label={`Open bill ${r.bookNumber}/${r.billNumber}`}>{r.billNumber}</Link> : <span className="tabular-nums">{r.billNumber}</span>),
    },
    { key: 'customerName', header: 'Customer Name', render: (r) => <Truncated text={r.customerName} width={136} /> },
    { key: 'mobileNumber', header: 'Mobile', render: (r) => <span className="whitespace-nowrap">{r.mobileNumber}</span> },
    // Baby Name and Planned Delivery are one click away (Columns): shown by default they push the money off a 1440 screen.
    { key: 'babyName', header: 'Baby Name', hidden: true, render: (r) => (r.babyName ? <Truncated text={r.babyName} width={120} /> : <span className="text-gray-400">{DASH}</span>) },
    { key: 'billDate', header: 'Bill Date', render: (r) => <span className="whitespace-nowrap">{fmt.date(r.billDate)}</span> },
    { key: 'plannedDelivery', header: 'Planned Delivery', hidden: true, render: (r) => (r.plannedDelivery ? <span className="whitespace-nowrap">{fmt.date(r.plannedDelivery)}</span> : <span className="text-gray-400">{DASH}</span>) },
    { key: 'seriesType', header: 'Series', hidden: true, sortable: false, render: (r) => INVOICE_TAX_MODE_LABELS[r.seriesType] },
    { key: 'subTotal', header: 'Sub Total', align: 'right', render: (r) => <Money n={r.subTotal} muted={false} /> },
    { key: 'discount', header: 'Discount', align: 'right', render: (r) => <Money n={r.discount} /> },
    { key: 'gst', header: 'GST', align: 'right', render: (r) => <Money n={r.gst} /> },
    { key: 'grandTotal', header: 'Grand Total', align: 'right', render: (r) => <span className="font-medium"><Money n={r.grandTotal} muted={false} /></span> },
    { key: 'advance', header: ADVANCE, headerClassName: ADVANCE_HEAD, align: 'right', render: (r) => <Money n={r.advance} /> },
    { key: 'paymentStatus', header: 'Payment', hidden: true, sortable: false, render: (r) => <BillPaymentStatusBadge status={r.paymentStatus} /> },
  ];

  const build = async (): Promise<ReportPrintData> => {
    const d = await fetchWholeBillReport('summary', props.scope, list);
    return {
      title: 'Bill Summary Report',
      caption,
      summary: printSummary(d.totals),
      headers: ['Book No.', 'Bill No.', 'Customer Name', 'Mobile', 'Baby Name', 'Bill Date', 'Planned Delivery', 'Sub Total', 'Discount', 'GST', 'Grand Total', ADVANCE],
      numeric: [1, 7, 8, 9, 10, 11],
      nowrap: [1, 3, 5, 6, 7, 8, 9, 10, 11],
      rows: d.rows.map((r) => [
        r.bookNumber,
        String(r.billNumber),
        r.customerName,
        r.mobileNumber,
        r.babyName ?? '',
        fmt.date(r.billDate),
        r.plannedDelivery ? fmt.date(r.plannedDelivery) : '',
        fmtMoney(r.subTotal),
        fmtMoney(r.discount),
        fmtMoney(r.gst),
        fmtMoney(r.grandTotal),
        fmtMoney(r.advance),
      ]),
      totals: ['Total', plural(d.totals.bills, 'bill'), '', '', '', '', '', fmtMoney(d.totals.subTotal), fmtMoney(d.totals.discount), fmtMoney(d.totals.gst), fmtMoney(d.totals.grandTotal), fmtMoney(d.totals.advance)],
      landscape: true,
    };
  };

  return (
    <>
      <BillReportFilterBar resolved={resolved} caption={caption} searchActive={!!list.search} onClearAll={props.onClearAll} />
      <DataTable
        storageKey="bill-report-summary"
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
        searchPlaceholder="Search customer, mobile, bill no., item..."
        actions={actions(build)}
        onRefresh={() => q.refetch()}
        {...empty}
        totalsRow={t && {
          bookNumber: 'Total',
          billNumber: <span className="whitespace-nowrap font-normal text-gray-600">{plural(t.bills, 'bill')}</span>,
          subTotal: <Money n={t.subTotal} muted={false} />,
          discount: <Money n={t.discount} muted={false} />,
          gst: <span className="font-normal tabular-nums text-gray-500" title="GST total (a column total; the primary totals are Sub Total, Discount, Advance / Received and Grand Total)">{fmtMoney(t.gst)}</span>,
          grandTotal: <Money n={t.grandTotal} muted={false} />,
          advance: <Money n={t.advance} muted={false} />,
        }}
        footer={<TotalsNote items={t && t.bills > 0 ? totalItems(t) : []} />}
        mobileCard={(r) => (
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-gray-900">{r.bookNumber}/{r.billNumber} · {r.customerName}</span>
              <span className="font-medium"><Money n={r.grandTotal} muted={false} /></span>
            </div>
            <div className="mt-0.5 text-[12px] text-gray-500">{fmt.date(r.billDate)} · {r.mobileNumber}{r.babyName ? ` · ${r.babyName}` : ''}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-gray-500 tabular-nums">
              <span>Sub {fmtMoney(r.subTotal)}</span>
              {r.discount > 0 && <span>Disc {fmtMoney(r.discount)}</span>}
              {r.gst > 0 && <span>GST {fmtMoney(r.gst)}</span>}
              <span>Adv/Rcvd {fmtMoney(r.advance)}</span>
            </div>
          </div>
        )}
      />
      {print.sheet}
    </>
  );
}

/* --------------------------------------------------------------- detailed -- */

/** A bill's identity cells show on the first of its lines on the page; the lines below leave them blank. */
const startsBill = (rows: BillDetailRow[], i: number) => i === 0 || rows[i - 1].billId !== rows[i].billId;

function DetailedTab(props: TabProps) {
  const { list, setList } = props;
  const { q, resolved, caption, print, empty, actions } = useReportShell('detailed', props);
  const fmt = useDateFormatters();
  const canBill = useAuthStore((s) => s.can)('operations_billing');
  const rows = q.data?.rows ?? [];
  const t: BillDetailTotals | undefined = q.data?.totals;
  const billCell = (render: (r: BillDetailRow) => ReactNode) => (r: BillDetailRow, i: number) => (startsBill(rows, i) ? render(r) : null);

  const columns: Column<BillDetailRow>[] = [
    // Bill Date, Mobile, Baby Name, Rate (= Amount at Qty 1, the studio's usual), GST % and Taxable are one
    // click away (Columns), so the money fits a 1440 screen. Print and CSV carry them all.
    { key: 'billDate', header: 'Bill Date', hidden: true, render: billCell((r) => <span className="whitespace-nowrap">{fmt.date(r.billDate)}</span>) },
    { key: 'bookNumber', header: 'Book No.', locked: true, render: billCell((r) => <Truncated text={r.bookNumber} width={86} />) },
    {
      key: 'billNumber',
      header: 'Bill No.',
      render: billCell((r) => (canBill ? <Link to={`/modules/billing/${r.billId}`} className="link tabular-nums" aria-label={`Open bill ${r.bookNumber}/${r.billNumber}`}>{r.billNumber}</Link> : <span className="tabular-nums">{r.billNumber}</span>)),
    },
    { key: 'customerName', header: 'Customer', render: billCell((r) => <Truncated text={r.customerName} width={104} />) },
    { key: 'mobileNumber', header: 'Mobile', hidden: true, render: billCell((r) => <span className="whitespace-nowrap">{r.mobileNumber}</span>) },
    { key: 'babyName', header: 'Baby Name', hidden: true, render: billCell((r) => r.babyName ?? '') },
    {
      key: 'productName',
      header: 'Item / Product',
      sortable: false,
      render: (r) => (
        <span className="block max-w-[170px] truncate" title={`${r.itemName} · ${r.productName}`}>
          <span className="text-gray-500">{r.itemName} · </span>{r.productName}
        </span>
      ),
    },
    { key: 'quantity', header: 'Qty', align: 'right', sortable: false, render: (r) => <span className="tabular-nums">{qty(r.quantity)}</span> },
    { key: 'rate', header: 'Rate', align: 'right', sortable: false, hidden: true, render: (r) => <Money n={r.rate} muted={false} /> },
    { key: 'amount', header: 'Amount', align: 'right', sortable: false, render: (r) => <Money n={r.amount} muted={false} /> },
    { key: 'discount', header: 'Discount', align: 'right', sortable: false, render: (r) => <Money n={r.discount} /> },
    { key: 'taxable', header: 'Taxable', align: 'right', sortable: false, hidden: true, render: (r) => <Money n={r.taxable} muted={false} /> },
    { key: 'gstRate', header: 'GST %', align: 'right', sortable: false, hidden: true, render: (r) => <span className="tabular-nums text-gray-600">{pct(r.gstRate)}</span> },
    { key: 'gst', header: 'GST', align: 'right', sortable: false, render: (r) => <Money n={r.gst} /> },
    { key: 'lineTotal', header: 'Line Total', align: 'right', sortable: false, render: (r) => <span className="font-medium"><Money n={r.lineTotal} muted={false} /></span> },
    { key: 'advance', header: ADVANCE, headerClassName: ADVANCE_HEAD, align: 'right', render: (r) => <Money n={r.advance} /> },
  ];

  const build = async (): Promise<ReportPrintData> => {
    const d = await fetchWholeBillReport('detailed', props.scope, list);
    const first = d.rows.map((_, i) => startsBill(d.rows, i));
    return {
      title: 'Bill Detailed Report',
      caption,
      summary: printSummary(d.totals),
      headers: ['Bill', 'Bill Date', 'Customer', 'Item', 'Product', 'Qty', 'Rate', 'Amount', 'Discount', 'GST %', 'GST', 'Line Total', ADVANCE],
      numeric: [5, 6, 7, 8, 9, 10, 11, 12],
      nowrap: [1, 6, 7, 8, 10, 11, 12],
      rows: d.rows.map((r, i) => [
        first[i] ? `${r.bookNumber}/${r.billNumber}` : '',
        first[i] ? fmt.date(r.billDate) : '',
        first[i] ? r.customerName : '',
        r.itemName,
        r.productName,
        qty(r.quantity),
        fmtMoney(r.rate),
        fmtMoney(r.amount),
        fmtMoney(r.discount),
        pct(r.gstRate),
        fmtMoney(r.gst),
        fmtMoney(r.lineTotal),
        r.advance === null ? '' : fmtMoney(r.advance),
      ]),
      groupStart: first,
      totals: ['Total', '', `${plural(d.totals.bills, 'bill')} · ${plural(d.totals.items, 'item')}`, '', '', '', '', fmtMoney(d.totals.subTotal), fmtMoney(d.totals.discount), '', fmtMoney(d.totals.gst), fmtMoney(d.totals.grandTotal), fmtMoney(d.totals.advance)],
      landscape: true,
    };
  };

  return (
    <>
      <BillReportFilterBar resolved={resolved} caption={caption} searchActive={!!list.search} onClearAll={props.onClearAll} />
      <DataTable
        storageKey="bill-report-detailed"
        columnsButton
        dense
        compact
        columns={columns}
        rows={rows}
        total={q.data?.total ?? 0}
        loading={q.isFetching}
        state={list}
        onStateChange={setList}
        rowKey={(r) => r.key}
        rowClassName={(_, i) => i > 0 && startsBill(rows, i) && 'border-t border-t-gray-300'}
        filterFields={false}
        searchPlaceholder="Search customer, mobile, bill no., item..."
        actions={actions(build)}
        onRefresh={() => q.refetch()}
        {...empty}
        totalsRow={t && {
          bookNumber: 'Total',
          productName: <span className="whitespace-nowrap font-normal text-gray-600">{plural(t.bills, 'bill')} · {plural(t.items, 'item')}</span>,
          amount: <Money n={t.subTotal} muted={false} />,
          discount: <Money n={t.discount} muted={false} />,
          taxable: <Money n={t.taxable} muted={false} />,
          gst: <span className="font-normal tabular-nums text-gray-500" title="GST total (a column total; the primary totals are Sub Total, Discount, Advance / Received and Grand Total)">{fmtMoney(t.gst)}</span>,
          lineTotal: <Money n={t.grandTotal} muted={false} />,
          advance: <Money n={t.advance} muted={false} />,
        }}
        footer={<TotalsNote items={t && t.bills > 0 ? [['Items', t.items], ...totalItems(t)] : []} />}
        mobileCard={(r, i) => (
          <div>
            {startsBill(rows, i) && (
              <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px] text-gray-500">
                <span className="min-w-0 truncate"><span className="font-medium text-gray-800">{r.bookNumber}/{r.billNumber}</span> · {r.customerName} · {fmt.date(r.billDate)}</span>
                {r.advance !== null && <span className="shrink-0 tabular-nums">Adv/Rcvd {fmtMoney(r.advance)}</span>}
              </div>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-gray-900">{r.itemName} · {r.productName}</span>
              <span className="font-medium"><Money n={r.lineTotal} muted={false} /></span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] tabular-nums text-gray-500">
              <span>{qty(r.quantity)} × {fmtMoney(r.rate)}</span>
              {r.discount > 0 && <span>Disc {fmtMoney(r.discount)}</span>}
              <span>GST {pct(r.gstRate)} {fmtMoney(r.gst)}</span>
            </div>
          </div>
        )}
      />
      {print.sheet}
    </>
  );
}

