import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  BILL_PAYMENT_STATUSES,
  BILL_PAYMENT_STATUS_LABELS,
  BILL_REPORT_TABS,
  INVOICE_TAX_MODES,
  INVOICE_TAX_MODE_LABELS,
  isIsoDate,
  type BillPaymentStatus,
  type BillReportTab,
  type InvoiceTaxMode,
} from '@erp/shared';
import { DateInput, Select, Spinner, TextInput } from '@/components/ui';
import { cx } from '@/lib/format';
import { useDateFormatters } from '@/lib/settings';
import { useBillReportCustomer, useBillReportCustomers, type BillReportScope } from '@/lib/billReport';
import { useReportBooks } from './reportScope';

/**
 * The Bill Summary Report's ONE scope, shared by both tabs. It lives in the URL (`from`, `to`,
 * `customer`, `book`, `series`, `billNo`, `payment`, and `tab`), so switching tabs never resets it,
 * Back restores it and a filtered view can be bookmarked. Only complete ISO dates are read.
 */
export function useBillReportScope() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) || undefined;
  const date = (k: string) => {
    const v = params.get(k);
    return isIsoDate(v) ? v : undefined;
  };
  const scope: BillReportScope = {
    from: date('from'),
    to: date('to'),
    customer: get('customer'),
    bookId: get('book'),
    seriesType: INVOICE_TAX_MODES.find((m) => m === params.get('series')),
    billNumber: /^[1-9]\d{0,8}$/.test(params.get('billNo') ?? '') ? get('billNo') : undefined,
    paymentStatus: BILL_PAYMENT_STATUSES.find((s) => s === params.get('payment')),
  };
  const tab: BillReportTab = BILL_REPORT_TABS.find((t) => t === params.get('tab')) ?? 'summary';
  /** The table's search (`q`): part of the scope, kept apart because the table owns its search box. */
  const search = get('q');
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };
  const moreCount = [scope.bookId, scope.seriesType, scope.billNumber, scope.paymentStatus].filter(Boolean).length;
  return { scope, tab, search, set, moreCount };
}

type More = { book?: string; series?: InvoiceTaxMode; billNo?: string; payment?: BillPaymentStatus };
const NO_MORE: Record<keyof More, undefined> = { book: undefined, series: undefined, billNo: undefined, payment: undefined };

/**
 * Bill date range · Customer · More filters · Clear. Dates and Customer apply at once; More filters
 * is a small panel with Apply / Clear. `resolved` is the range the server actually used (the current
 * month when none is chosen), so the active dates are always on screen.
 */
export function BillReportFilterBar({ resolved, caption, searchActive, onClearAll }: { resolved?: { from: string | null; to: string | null }; caption: string; searchActive: boolean; onClearAll: () => void }) {
  const { scope, set, moreCount } = useBillReportScope();
  const [open, setOpen] = useState(false);
  const from = scope.from ?? resolved?.from ?? '';
  const to = scope.to ?? resolved?.to ?? '';
  const dirty = !!(scope.from || scope.to || scope.customer || moreCount || searchActive);
  // Changing one end of the default range keeps the other end as shown.
  const setDate = (k: 'from' | 'to', v: string) => {
    if (v !== '' && !isIsoDate(v)) return;
    set({ from: k === 'from' ? v || undefined : from || undefined, to: k === 'to' ? v || undefined : to || undefined });
  };

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Bill date range" className="flex items-center gap-1.5 text-[12px] text-gray-500">
          <span className="whitespace-nowrap">Bill date</span>
          <DateInput size="sm" className="w-[132px]" aria-label="Bill date from" value={from} onChange={(v) => setDate('from', v)} />
          <span className="text-gray-400">to</span>
          <DateInput size="sm" className="w-[132px]" aria-label="Bill date to" value={to} onChange={(v) => setDate('to', v)} />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-gray-500 max-sm:w-full">
          <span>Customer</span>
          <CustomerFilter value={scope.customer} onChange={(key) => set({ customer: key })} />
        </div>
        <button type="button" className={cx('btn-outline', moreCount > 0 && 'border-primary/40 text-primary-dark')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal className="h-4 w-4" /> More filters
          {moreCount > 0 && <span className="badge bg-primary text-white">{moreCount}</span>}
        </button>
        {dirty && (
          <button type="button" className="btn-ghost text-primary" onClick={() => { setOpen(false); onClearAll(); }}>
            <RotateCcw className="h-3.5 w-3.5" /> Clear all
          </button>
        )}
      </div>
      {/* The whole active scope in words — the same line the print carries. */}
      {caption.includes(' · ') && <p className="mt-1.5 text-[12px] text-gray-500" aria-live="polite">{caption}</p>}
      {open && (
        <MoreFilters
          value={{ book: scope.bookId, series: scope.seriesType, billNo: scope.billNumber, payment: scope.paymentStatus }}
          onApply={(m) => { set({ ...NO_MORE, ...m }); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Book · Series · Bill No. · Payment — kept behind "More filters", applied together. */
function MoreFilters({ value, onApply, onClose }: { value: More; onApply: (m: More) => void; onClose: () => void }) {
  const [d, setD] = useState<More>(value);
  const books = useReportBooks();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.querySelector<HTMLElement>('select, input')?.focus(), []);
  const field = 'flex flex-col gap-1 text-[12px] text-gray-500';
  return (
    <div ref={panel} role="region" aria-label="More filters" className="card mt-2 flex flex-wrap items-end gap-3 px-4 py-3" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <label className={field}>
        Book
        <Select size="sm" className="w-[170px]" value={d.book ?? ''} placeholder="All books" onChange={(v) => setD({ ...d, book: v || undefined })} options={(books.data ?? []).map((b) => ({ value: b.id, label: b.isActive ? b.bookNumber : `${b.bookNumber} (inactive)` }))} />
      </label>
      <label className={field}>
        Series
        <Select size="sm" className="w-[140px]" value={d.series ?? ''} placeholder="Both" onChange={(v) => setD({ ...d, series: INVOICE_TAX_MODES.find((m) => m === v) })} options={INVOICE_TAX_MODES.map((m) => ({ value: m, label: INVOICE_TAX_MODE_LABELS[m] }))} />
      </label>
      <label className={field}>
        Bill No.
        <TextInput size="sm" className="w-[110px]" inputMode="numeric" maxLength={9} value={d.billNo ?? ''} onChange={(e) => setD({ ...d, billNo: e.target.value.replace(/\D/g, '').replace(/^0+/, '') || undefined })} onKeyDown={(e) => e.key === 'Enter' && onApply(d)} />
      </label>
      <label className={field}>
        Payment
        <Select size="sm" className="w-[150px]" value={d.payment ?? ''} placeholder="Any" onChange={(v) => setD({ ...d, payment: BILL_PAYMENT_STATUSES.find((s) => s === v) })} options={BILL_PAYMENT_STATUSES.map((s) => ({ value: s, label: BILL_PAYMENT_STATUS_LABELS[s] }))} />
      </label>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-outline" onClick={() => onApply({})}>Clear</button>
        <button type="button" className="btn-primary" onClick={() => onApply(d)}>Apply</button>
      </div>
    </div>
  );
}

const DEBOUNCE_MS = 300;

/**
 * The customer — a normalized mobile, the temporary customer identity — searched on the SERVER by
 * name or mobile among customers who have bills. Keyboard: type, Up/Down, Enter picks, Escape closes.
 */
function CustomerFilter({ value, onChange }: { value?: string; onChange: (key: string | undefined) => void }) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = useBillReportCustomer(value);
  const q = useBillReportCustomers(search, open && !value);
  const rows = q.data ?? [];
  const optionId = (i: number) => `${listId}-o${i}`;

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setActive(0), [search]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
    setText('');
  };

  if (value) {
    const c = chosen.data;
    return (
      <div className="input input-sm flex w-[240px] items-center gap-2 pr-1 max-sm:flex-1">
        <span className="min-w-0 flex-1 truncate text-gray-900" title={c ? `${c.customerName} · ${c.mobileNumber}` : value}>
          {c ? c.customerName : value}
          {c && <span className="ml-1.5 text-gray-500">{c.mobileNumber}</span>}
        </span>
        <button type="button" className="row-action h-6 w-6" aria-label="Clear customer" title="All customers" onClick={() => { onChange(undefined); setTimeout(() => input.current?.focus(), 0); }}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative w-[240px] max-sm:flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" strokeWidth={1.5} />
      <input
        ref={input}
        className="input input-sm pl-8"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
        aria-label="Customer"
        placeholder="All customers"
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={(e) => !box.current?.contains(e.relatedTarget as Node) && setOpen(false)}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.max(0, Math.min(i + 1, rows.length - 1))); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && rows[active]) pick(rows[active].customerKey); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Customers" className="card absolute left-0 z-50 mt-1 max-h-72 w-[320px] max-w-[calc(100vw-2rem)] overflow-y-auto py-1 shadow-lg">
          {q.isLoading && <li className="flex items-center gap-2 px-3 py-2 text-[13px] text-gray-500"><Spinner className="h-3 w-3" /> Searching…</li>}
          {q.isError && <li className="px-3 py-2 text-[13px] text-red-600">Customers could not be loaded.</li>}
          {!q.isLoading && !q.isError && rows.length === 0 && <li className="px-3 py-2 text-[13px] text-gray-500">No customer with a bill matches.</li>}
          {rows.map((c, i) => (
            <li
              key={c.customerKey}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c.customerKey)}
              className={cx('flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13px]', i === active ? 'bg-primary-lighter/60' : 'hover:bg-gray-50')}
            >
              <span className="min-w-0 truncate">
                <span className="text-gray-900">{c.customerName}</span>
                <span className="ml-2 text-gray-500">{c.mobileNumber}</span>
              </span>
              <span className="shrink-0 text-[12px] text-gray-500">{c.billCount} {c.billCount === 1 ? 'bill' : 'bills'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Bill date 01-09-2026 – 26-09-2026 · Customer … · Book … · With GST · Bill No. 12 · Unpaid · Search "…"" */
export function useBillReportCaption(resolved: { from: string | null; to: string | null } | undefined, search: string) {
  const { scope } = useBillReportScope();
  const fmt = useDateFormatters();
  const customer = useBillReportCustomer(scope.customer).data;
  const book = useReportBooks().data?.find((b) => b.id === scope.bookId)?.bookNumber;
  const from = scope.from ?? resolved?.from;
  const to = scope.to ?? resolved?.to;
  return [
    from || to ? `Bill date ${from ? fmt.date(from) : '…'} – ${to ? fmt.date(to) : '…'}` : 'All bill dates',
    scope.customer && `Customer ${customer ? `${customer.customerName} (${customer.mobileNumber})` : scope.customer}`,
    scope.bookId && `Book ${book ?? ''}`.trim(),
    scope.seriesType && INVOICE_TAX_MODE_LABELS[scope.seriesType],
    scope.billNumber && `Bill No. ${scope.billNumber}`,
    scope.paymentStatus && BILL_PAYMENT_STATUS_LABELS[scope.paymentStatus],
    search && `Search "${search}"`,
  ]
    .filter(Boolean)
    .join(' · ');
}
