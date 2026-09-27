import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { isIsoDate } from '@erp/shared';
import { MONTHS_LONG, MONTHS_SHORT, WEEKDAYS, addDays, addMonths, between, isoOf, monthGrid, partsOf, weekdayOf } from '@/lib/calendar';
import { cx } from '@/lib/format';

/**
 * The month calendar inside DateInput's pop-up. It works only on business dates ("YYYY-MM-DD",
 * lib/calendar.ts), so a picked day is exactly the day stored — no timezone can move it.
 *
 * Three views, one panel: days → (click the caption) months of a year → (click the year) a page
 * of twelve years, so an old Birth Date is three or four clicks away, not forty months of arrows.
 *
 * Keyboard in the day grid: arrows move a day / a week, PageUp/PageDown a month (with Shift a
 * year), Home/End the week's start/end, Enter or Space picks. Escape is handled by the pop-up.
 */
type View = 'days' | 'months' | 'years';

export function Calendar({ value, today, onSelect, onToday, onClear, min, max, rangeFrom, rangeTo, defaultMonth, autoFocus }: {
  value: string;
  /** Today's business date — marked in the grid and used by the Today action. */
  today: string;
  onSelect: (iso: string) => void;
  /** Shown only when given: a field where today is a sensible pick. */
  onToday?: () => void;
  /** Shown only when given: optional fields. A required field never offers Clear. */
  onClear?: () => void;
  /** Days outside [min, max] are shown but cannot be picked (a report's To before its From). */
  min?: string;
  max?: string;
  /** The other end of a date range, so the span between is visible while picking. */
  rangeFrom?: string;
  rangeTo?: string;
  /** The month to open on when there is no value yet. */
  defaultMonth?: string;
  autoFocus?: boolean;
}) {
  const start = isIsoDate(value) ? value : defaultMonth && isIsoDate(defaultMonth) ? defaultMonth : today;
  const [focusDay, setFocusDay] = useState(start);
  const [view, setView] = useState<View>('days');
  const grid = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(!!autoFocus);
  const { y, m } = partsOf(focusDay);
  const selectable = (iso: string) => between(iso, min, max);

  // Keep DOM focus on the roving day once the grid owns focus (or the pop-up opened from the keyboard).
  useEffect(() => {
    if (view !== 'days' || !wantFocus.current) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, view]);

  const move = (to: string) => {
    wantFocus.current = true;
    setFocusDay(to);
  };
  const onGridKey = (e: KeyboardEvent) => {
    const map: Record<string, () => string> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      PageUp: () => addMonths(focusDay, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focusDay, e.shiftKey ? 12 : 1),
      Home: () => addDays(focusDay, -weekdayOf(focusDay)),
      End: () => addDays(focusDay, 6 - weekdayOf(focusDay)),
    };
    const next = map[e.key];
    if (next) {
      e.preventDefault();
      move(next());
    } else if ((e.key === 'Enter' || e.key === ' ') && selectable(focusDay)) {
      e.preventDefault();
      onSelect(focusDay);
    }
  };

  const lo = rangeFrom && rangeTo ? rangeFrom : undefined;
  const hi = rangeFrom && rangeTo ? rangeTo : undefined;
  const yearPage = Math.floor(y / 12) * 12;
  const navBtn = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  const cellBtn = 'rounded-md text-[13px] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

  const step = (dir: -1 | 1) => {
    wantFocus.current = false;
    setFocusDay(view === 'days' ? addMonths(focusDay, dir) : view === 'months' ? addMonths(focusDay, 12 * dir) : addMonths(focusDay, 144 * dir));
  };
  const caption = view === 'days' ? `${MONTHS_LONG[m - 1]} ${y}` : view === 'months' ? String(y) : `${yearPage} – ${yearPage + 11}`;
  const prevLabel = view === 'days' ? 'Previous month' : view === 'months' ? 'Previous year' : 'Previous years';
  const nextLabel = view === 'days' ? 'Next month' : view === 'months' ? 'Next year' : 'Next years';

  return (
    <div className="w-[256px] select-none p-2">
      <div className="mb-1 flex items-center justify-between">
        <button type="button" className={navBtn} aria-label={prevLabel} onClick={() => step(-1)}><ChevronLeft className="h-4 w-4" strokeWidth={1.75} /></button>
        <button
          type="button"
          className="h-7 rounded-md px-2 text-[13px] font-semibold text-gray-800 transition-colors duration-150 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:hover:bg-transparent"
          aria-label={view === 'days' ? `${caption}, choose month and year` : view === 'months' ? `${caption}, choose year` : caption}
          aria-live="polite"
          disabled={view === 'years'}
          onClick={() => setView(view === 'days' ? 'months' : 'years')}
        >
          {caption}
        </button>
        <button type="button" className={navBtn} aria-label={nextLabel} onClick={() => step(1)}><ChevronRight className="h-4 w-4" strokeWidth={1.75} /></button>
      </div>

      {view === 'days' && (
        <div role="grid" aria-label={`${MONTHS_LONG[m - 1]} ${y}`} ref={grid} onKeyDown={onGridKey}>
          <div role="row" className="grid grid-cols-7">
            {WEEKDAYS.map((w) => <span key={w} role="columnheader" className="flex h-7 items-center justify-center text-[11px] font-medium text-gray-400">{w}</span>)}
          </div>
          {Array.from({ length: 6 }, (_, week) => (
            <div role="row" key={week} className="grid grid-cols-7">
              {monthGrid(y, m).slice(week * 7, week * 7 + 7).map((iso) => {
                const inMonth = partsOf(iso).m === m;
                const selected = iso === value;
                const ok = selectable(iso);
                const inRange = !!lo && !!hi && iso > lo && iso < hi;
                const edge = !selected && (iso === rangeFrom || iso === rangeTo);
                return (
                  <span role="gridcell" key={iso} aria-selected={selected} className={cx('flex h-8 items-center justify-center', inRange && 'bg-primary-50')}>
                    <button
                      type="button"
                      data-day={iso}
                      tabIndex={iso === focusDay ? 0 : -1}
                      disabled={!ok}
                      aria-label={`${partsOf(iso).d} ${MONTHS_LONG[partsOf(iso).m - 1]} ${partsOf(iso).y}${iso === today ? ', today' : ''}`}
                      aria-current={iso === today ? 'date' : undefined}
                      onClick={() => onSelect(iso)}
                      onFocus={() => { wantFocus.current = true; if (iso !== focusDay) setFocusDay(iso); }}
                      className={cx(
                        cellBtn,
                        'h-8 w-8 tabular-nums',
                        selected ? 'bg-primary font-medium text-white hover:bg-primary-dark'
                          : edge ? 'bg-primary-lighter text-primary-dark'
                          : cx(inMonth ? 'text-gray-700' : 'text-gray-400', 'hover:bg-gray-100'),
                        !selected && iso === today && 'font-semibold text-primary ring-1 ring-inset ring-primary/40',
                        !ok && 'pointer-events-none opacity-35',
                      )}
                    >
                      {partsOf(iso).d}
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {view === 'months' && (
        <div className="grid grid-cols-3 gap-1 py-1" role="group" aria-label={`Months of ${y}`}>
          {MONTHS_SHORT.map((label, i) => {
            const on = isIsoDate(value) && partsOf(value).y === y && partsOf(value).m === i + 1;
            return (
              <button
                key={label}
                type="button"
                aria-label={`${MONTHS_LONG[i]} ${y}`}
                aria-pressed={on}
                onClick={() => { wantFocus.current = true; setFocusDay(isoOf(y, i + 1, 1)); setView('days'); }}
                className={cx(cellBtn, 'h-10', on ? 'bg-primary text-white hover:bg-primary-dark' : 'text-gray-700 hover:bg-gray-100')}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {view === 'years' && (
        <div className="grid grid-cols-3 gap-1 py-1" role="group" aria-label="Years">
          {Array.from({ length: 12 }, (_, i) => yearPage + i).map((yr) => {
            const on = isIsoDate(value) && partsOf(value).y === yr;
            return (
              <button
                key={yr}
                type="button"
                aria-pressed={on}
                onClick={() => { setFocusDay(isoOf(yr, m, 1)); setView('months'); }}
                className={cx(cellBtn, 'h-10 tabular-nums', on ? 'bg-primary text-white hover:bg-primary-dark' : yr === partsOf(today).y ? 'font-semibold text-primary hover:bg-gray-100' : 'text-gray-700 hover:bg-gray-100')}
              >
                {yr}
              </button>
            );
          })}
        </div>
      )}

      {(onToday || onClear) && (
        <div className="mt-1 flex items-center justify-between border-t border-line pt-1.5">
          {onToday ? <button type="button" className="h-7 rounded-md px-2 text-[12px] font-medium text-primary transition-colors duration-150 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40" disabled={!selectable(today)} onClick={onToday}>Today</button> : <span />}
          {onClear && <button type="button" className="h-7 rounded-md px-2 text-[12px] text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" onClick={onClear}>Clear</button>}
        </div>
      )}
    </div>
  );
}
