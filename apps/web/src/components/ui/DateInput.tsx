import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays } from 'lucide-react';
import { dateFormatLabel, formatDateOnly, isIsoDate, parseDisplayDate } from '@erp/shared';
import { useDisplayFormats } from '@/lib/settings';
import { cx, todayISO } from '@/lib/format';
import { Calendar } from './Calendar';

/**
 * The app's date field. Shows and accepts the date in the tenant's Date Format setting; the
 * value it reports is always the canonical "YYYY-MM-DD" (or '' when blank).
 *
 * Why not a plain <input type="date">: the browser renders that field — and its calendar — in the
 * OPERATING SYSTEM's locale, so an en-US Windows shows 09/25/2026 whatever Settings says. Here both
 * the text and the calendar pop-up (Calendar.tsx) are ours, and the calendar works on business
 * dates only, so a picked day can never shift through a timezone.
 *
 * While the operator is typing, text that is not yet a real date is reported as typed, so a
 * form can refuse it with `validDate` rather than silently blanking it.
 *
 * Keyboard: type the date (any of / - . as separators, 1- or 2-digit day and month, or eight
 * digits "27092026"); Alt+↓ or F4 opens the calendar, Escape closes it back to the field. The
 * calendar button is skipped by Tab so the form's tab order stays field to field.
 */
export const DateInput = forwardRef<HTMLInputElement, {
  value: string | null | undefined;
  onChange: (value: string) => void;
  onBlur?: () => void;
  size?: 'sm';
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  className?: string;
  'aria-label'?: string;
  /** Offer Clear in the calendar — optional fields only; a required date never shows it. */
  clearable?: boolean;
  /** Offer Today in the calendar (default on). */
  showToday?: boolean;
  /** Bounds the calendar can pick within (a range's To never before its From). Typing is validated by the form / server. */
  min?: string;
  max?: string;
  /** The other end of a date range, shaded in the calendar. */
  rangeFrom?: string;
  rangeTo?: string;
  /** The month the calendar opens on when the field is empty. */
  defaultMonth?: string;
  /** Called after a day is picked in the calendar (not while typing) — a range moves on to its To. */
  onPicked?: (iso: string) => void;
  /** Change it to open the calendar from outside (a range opening its To after From was picked). */
  openKey?: number;
}>(function DateInput({ value, onChange, onBlur, size, disabled, readOnly, className, clearable, showToday = true, min, max, rangeFrom, rangeTo, defaultMonth, onPicked, openKey, ...rest }, ref) {
  const { dateFormat } = useDisplayFormats();
  const input = useRef<HTMLInputElement | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<null | { keyboard: boolean }>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, up: false });
  // The text the operator is typing, shown instead of the formatted value until blur. It is
  // dropped the moment the value changes from OUTSIDE (a form reset() after the modal has
  // autofocused the field, a prefill), so the field can never show a date the form does not hold.
  // A change caused by our own onChange is not "outside", whatever the parent stored for it.
  const [typing, setTyping] = useState<string | null>(null);
  const ownChange = useRef(false);
  const settled = useRef(value ?? '');
  const v = value ?? '';
  useLayoutEffect(() => {
    if (ownChange.current) {
      ownChange.current = false;
      settled.current = v;
    } else if (v !== settled.current) {
      settled.current = v;
      setTyping(null);
    }
  });
  const shown = typing ?? (isIsoDate(v) ? formatDateOnly(v, dateFormat) : v);
  const locked = disabled || readOnly;

  const setRef = (el: HTMLInputElement | null) => {
    input.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const PANEL_W = 272;
  const PANEL_H = 340;
  const place = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const up = window.innerHeight - r.bottom < PANEL_H && r.top > PANEL_H;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8));
    setPos({ top: up ? r.top : r.bottom, left, up });
  };
  const openCalendar = (keyboard: boolean) => {
    if (locked) return;
    place();
    setOpen({ keyboard });
  };
  const close = (refocus: boolean) => {
    setOpen(null);
    if (refocus) input.current?.focus();
  };
  const commit = (iso: string, picked: boolean) => {
    setTyping(null);
    onChange(iso);
    close(true);
    if (picked) onPicked?.(iso);
  };

  const lastOpenKey = useRef(openKey);
  useEffect(() => {
    if (openKey === undefined || openKey === lastOpenKey.current) return;
    lastOpenKey.current = openKey;
    input.current?.focus();
    openCalendar(true);
  }, [openKey]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // a date pop-up inside a Modal closes itself, not the Modal
      close(true);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Tab cycles inside the open pop-up; Escape leaves it. Handled entirely here and stopped, because
  // the pop-up is portalled to <body> and a surrounding Modal's own Tab trap would pull focus out.
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !pop.current) return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...pop.current.querySelectorAll<HTMLElement>('button:not([disabled])')].filter((b) => b.tabIndex !== -1);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
  };

  return (
    <div ref={wrap} className={cx('relative', className)}>
      <input
        ref={setRef}
        {...rest}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={dateFormatLabel(dateFormat)}
        value={shown}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={!!v && !isIsoDate(v)}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        onChange={(e) => {
          const text = e.target.value;
          const t = text.trim();
          ownChange.current = true;
          setTyping(text);
          onChange(t === '' ? '' : parseDisplayDate(t, dateFormat) ?? t);
        }}
        onBlur={() => {
          setTyping(null);
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') {
            e.preventDefault();
            openCalendar(true);
          }
        }}
        className={cx('input pr-8', size === 'sm' && 'input-sm')}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={locked}
        onClick={() => (open ? close(true) : openCalendar(false))}
        aria-label="Open calendar"
        aria-expanded={!!open}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-gray-400 transition-colors duration-150 hover:text-primary disabled:pointer-events-none"
      >
        <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label={`Choose ${rest['aria-label']?.toLowerCase() ?? 'date'}`}
            onKeyDown={trapTab}
            style={{ position: 'fixed', left: pos.left, width: PANEL_W, ...(pos.up ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}
            className="z-[110] flex justify-center rounded-lg border border-line bg-surface shadow-lg"
          >
            <Calendar
              value={isIsoDate(v) ? v : ''}
              today={todayISO()}
              min={min}
              max={max}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              defaultMonth={defaultMonth}
              autoFocus
              onSelect={(iso) => commit(iso, true)}
              onToday={showToday ? () => commit(todayISO(), true) : undefined}
              onClear={clearable ? () => commit('', false) : undefined}
            />
          </div>,
          document.body,
        )}
    </div>
  );
});

/** react-hook-form rule for a DateInput: blank is left to `required`, anything else must be a real date. */
export const validDate = (v: unknown) => !v || isIsoDate(v) || 'Enter a valid date';

/**
 * A From / To pair over DateInput: the calendar shades the span, To cannot be picked before From,
 * and picking From in the calendar always moves on to To (Escape keeps To as it is). Each end still commits exactly what the caller's
 * `onFrom` / `onTo` accept, so URL-persisted report filters keep their own rules.
 */
export function DateRangeInput({ from, to, onFrom, onTo, label, className, inputClassName = 'w-[132px]' }: {
  from?: string;
  to?: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  /** e.g. "Bill date" -> "Bill date from" / "Bill date to" */
  label: string;
  className?: string;
  inputClassName?: string;
}) {
  const [openTo, setOpenTo] = useState(0);
  const f = isIsoDate(from) ? from : undefined;
  const t = isIsoDate(to) ? to : undefined;
  return (
    <div role="group" aria-label={`${label} range`} className={cx('flex items-center gap-1.5', className)}>
      <DateInput size="sm" className={inputClassName} aria-label={`${label} from`} value={from ?? ''} onChange={onFrom} clearable max={t} rangeFrom={f} rangeTo={t} onPicked={() => setOpenTo((n) => n + 1)} />
      <span className="text-[12px] text-gray-400">to</span>
      <DateInput size="sm" className={inputClassName} aria-label={`${label} to`} value={to ?? ''} onChange={onTo} clearable min={f} rangeFrom={f} rangeTo={t} defaultMonth={f} openKey={openTo} />
    </div>
  );
}
