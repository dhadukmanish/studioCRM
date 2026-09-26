import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { isIsoDate, type ReceivablesOverview } from '@erp/shared';
import { DateInput, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import type { ReceivablesScope } from '@/lib/receivables';

/**
 * The receivables scope lives in the URL (`asOf`, `from`, `to`, `book`), so the KPI strip, every
 * tab, the customer drill-down and Back all describe the same bills — and a filtered view can be
 * bookmarked. Only complete ISO dates are ever read from it.
 */
export function useReportScope() {
  const [params, setParams] = useSearchParams();
  const date = (k: string) => {
    const v = params.get(k);
    return isIsoDate(v) ? v : undefined;
  };
  const scope: ReceivablesScope = { asOf: date('asOf'), from: date('from'), to: date('to'), bookId: params.get('book') || undefined };
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  return { scope, params, set };
}

/** Every book, closed ones too: an inactive book is closed to new bills but still reportable. */
const useReportBooks = () =>
  useQuery({ queryKey: ['lookup', 'books', 'all'], queryFn: () => api.get<{ id: string; bookNumber: string; isActive: boolean }[]>('/api/common/lookups/books?includeInactive=1'), staleTime: 60_000 });

export const useBookLabel = (bookId?: string) => useReportBooks().data?.find((b) => b.id === bookId)?.bookNumber;

/** A DateInput that only commits a complete date (or a clear) — half-typed text never reaches the URL. */
function ScopeDate({ label, value, onChange }: { label: string; value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
      <span className="whitespace-nowrap">{label}</span>
      <DateInput size="sm" className="w-[132px]" aria-label={label} value={value ?? ''} onChange={(v) => (v === '' ? onChange(undefined) : isIsoDate(v) ? onChange(v) : undefined)} />
    </label>
  );
}

/** As of · Bill date range · Book — the scope every report view shares. */
export function ScopeBar({ asOf }: { asOf?: string }) {
  const { scope, set } = useReportScope();
  const books = useReportBooks();
  const dirty = !!(scope.asOf || scope.from || scope.to || scope.bookId);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <ScopeDate label="As of" value={scope.asOf ?? asOf} onChange={(v) => set({ asOf: v })} />
      <div className="flex items-center gap-1.5">
        <ScopeDate label="Bill date" value={scope.from} onChange={(v) => set({ from: v })} />
        <span className="text-[12px] text-gray-400">–</span>
        <DateInput size="sm" className="w-[132px]" aria-label="Bill date to" value={scope.to ?? ''} onChange={(v) => (v === '' ? set({ to: undefined }) : isIsoDate(v) ? set({ to: v }) : undefined)} />
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
        <span>Book</span>
        <Select
          size="sm"
          className="w-[150px]"
          value={scope.bookId ?? ''}
          placeholder="All books"
          onChange={(v) => set({ book: v || undefined })}
          options={(books.data ?? []).map((b) => ({ value: b.id, label: b.isActive ? b.bookNumber : `${b.bookNumber} (inactive)` }))}
        />
      </label>
      {dirty && (
        <button type="button" className="btn-ghost text-primary" onClick={() => set({ asOf: undefined, from: undefined, to: undefined, book: undefined })}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
      )}
    </div>
  );
}

/** "As of 26-09-2026 · Bill date 01-04-2026 – 30-09-2026 · Book 2026-27" — for print headers and captions. */
export function useScopeText(scope: ReceivablesScope, asOf?: string) {
  const fmt = useDateFormatters();
  const book = useBookLabel(scope.bookId);
  const parts = [`As of ${fmt.date(scope.asOf ?? asOf ?? '')}`];
  if (scope.from || scope.to) parts.push(`Bill date ${scope.from ? fmt.date(scope.from) : '…'} – ${scope.to ? fmt.date(scope.to) : '…'}`);
  if (scope.bookId) parts.push(`Book ${book ?? ''}`.trim());
  return parts.join(' · ');
}

export interface Kpi {
  label: string;
  value: string;
  hint: string;
  strong?: boolean;
}

export const overviewKpis = (o?: ReceivablesOverview): Kpi[] => [
  { label: 'Billed', value: fmtMoney(o?.totalBilled), hint: 'Grand Total of every bill in scope — paid bills included' },
  { label: 'Received', value: fmtMoney(o?.totalReceived), hint: 'Allocations of active receipts dated on or before As of, against those bills' },
  { label: 'Outstanding', value: fmtMoney(o?.totalOutstanding), hint: 'Billed − Received', strong: true },
  { label: 'Customers owing', value: String(o?.customersWithOutstanding ?? 0), hint: 'Customers (by mobile number) with something outstanding' },
  { label: 'Pending bills', value: String(o?.pendingBills ?? 0), hint: 'Bills with something outstanding' },
];

/** A compact strip of figures — no oversized cards. */
export function KpiStrip({ items, loading }: { items: Kpi[]; loading?: boolean }) {
  return (
    <div className={cx('card mb-3 grid grid-cols-2 overflow-hidden sm:grid-cols-5', loading && 'opacity-60')}>
      {items.map((k, i) => (
        <div key={k.label} title={k.hint} className={cx('px-4 py-2.5', i > 0 && 'sm:border-l sm:border-line', i > 1 && 'border-t border-line sm:border-t-0', i % 2 === 1 && 'border-l border-line')}>
          <div className="text-[12px] text-gray-500">{k.label}</div>
          <div className={cx('tabular-nums text-[16px] text-gray-900', k.strong && 'font-semibold')}>{k.value}</div>
        </div>
      ))}
    </div>
  );
}
