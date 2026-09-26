import { useEffect, useState } from 'react';
import { Download, Eye, Printer, X } from 'lucide-react';
import { INVOICE_COLORS } from '@erp/shared';
import { DateInput, Modal } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cx } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ReportPrintSheet, ReportSheet, sheetWidth, type ReportPrintData } from './ReportPrintSheet';

/**
 * Small building blocks the operational reports share (Delivery, Appointments): quick-view chips
 * with the server's counts, an optional date range, and whole-result print / CSV actions.
 */

/** "Bill date 01/09/2026 – 30/09/2026", or '' when no range is set. */
export function rangeText(label: string, from: string | undefined, to: string | undefined, date: (v?: string | null) => string) {
  if (from && to) return `${label} ${date(from)} – ${date(to)}`;
  if (from) return `${label} from ${date(from)}`;
  if (to) return `${label} up to ${date(to)}`;
  return '';
}

/** A segmented row of quick views with the server's counts. Wraps on a phone; never scrolls the page. */
export function ViewChips<V extends string>({ label, views, labels, counts, value, onChange }: { label: string; views: readonly V[]; labels: Record<V, string>; counts?: Record<V, number>; value: V; onChange: (v: V) => void }) {
  return (
    <div role="group" aria-label={label} className="mb-3 flex flex-wrap gap-1.5">
      {views.map((v) => {
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={cx(
              'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 max-sm:h-9',
              on ? 'border-primary/40 bg-primary-50 text-primary-dark ring-1 ring-primary/30' : 'border-line bg-surface text-gray-600 hover:bg-gray-50',
            )}
          >
            {labels[v]}
            {counts && <span className={cx('tabular-nums text-[12px]', on ? 'text-primary-dark' : 'text-gray-400')}>{counts[v]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** An optional From / To date range for the table toolbar. Dates only through DateInput. */
export function DateRange({ label, from, to, onChange }: { label: string; from?: string; to?: string; onChange: (r: { from?: string; to?: string }) => void }) {
  return (
    <div role="group" aria-label={`${label} range`} className="flex items-center gap-1.5">
      <DateInput size="sm" className="w-[132px]" value={from ?? ''} onChange={(v) => onChange({ from: v || undefined, to })} aria-label={`${label} from`} />
      <span className="text-[12px] text-gray-400">to</span>
      <DateInput size="sm" className="w-[132px]" value={to ?? ''} onChange={(v) => onChange({ from, to: v || undefined })} aria-label={`${label} to`} />
      {(from || to) && (
        <button type="button" className="row-action" title="Clear dates" aria-label={`Clear ${label.toLowerCase()} range`} onClick={() => onChange({})}><X className="h-4 w-4" /></button>
      )}
    </div>
  );
}

/**
 * Print the WHOLE filtered result: fetch it, render the paper sheet, print, clear. `'preview'`
 * shows that same sheet in a dialog first, with Print on it.
 */
export function useReportPrint() {
  const [data, setData] = useState<ReportPrintData | null>(null);
  const [preview, setPreview] = useState<ReportPrintData | null>(null);
  const [busy, setBusy] = useState<'print' | 'preview' | null>(null);
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      window.print();
      setData(null);
    }, 150);
    return () => clearTimeout(t);
  }, [data]);
  const run = async (build: () => Promise<ReportPrintData>, mode: 'print' | 'preview' = 'print') => {
    setBusy(mode);
    try {
      const d = await build();
      (mode === 'print' ? setData : setPreview)(d);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The report could not be prepared for printing');
    } finally {
      setBusy(null);
    }
  };
  const sheet = (
    <>
      {data && <ReportPrintSheet data={data} />}
      {preview && (
        <Modal
          open
          size="full"
          onClose={() => setPreview(null)}
          title={`Preview · ${preview.title}`}
          footer={
            <>
              <button type="button" className="btn-outline" onClick={() => setPreview(null)}>Close</button>
              <button type="button" className="btn-primary" onClick={() => { setPreview(null); setData(preview); }}><Printer className="h-4 w-4" /> Print</button>
            </>
          }
        >
          {/* The same sheet that prints, at its paper width; a phone scrolls it sideways inside the dialog. */}
          <div className="overflow-x-auto rounded border border-line bg-gray-100 p-3">
            <div className="mx-auto shadow-sm" style={{ width: sheetWidth(preview.landscape), padding: '6mm', background: INVOICE_COLORS.paper }}>
              <ReportSheet data={preview} />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
  return { sheet, run, busy: busy === 'print', previewing: busy === 'preview' };
}

/** Runs one async action at a time, toasting the server's message when it fails. */
export function useBusyAction(fallback: string) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

export function ReportActions({ onPrint, onPreview, onCsv, printing, previewing, exporting }: { onPrint: () => void; onPreview?: () => void; onCsv: () => void; printing: boolean; previewing?: boolean; exporting: boolean }) {
  return (
    <>
      {onPreview && <button type="button" className="btn-outline" onClick={onPreview} disabled={previewing}><Eye className="h-4 w-4" /> Preview</button>}
      <button type="button" className="btn-outline" onClick={onPrint} disabled={printing}><Printer className="h-4 w-4" /> Print</button>
      <button type="button" className="btn-outline" onClick={onCsv} disabled={exporting}><Download className="h-4 w-4" /> CSV</button>
    </>
  );
}
