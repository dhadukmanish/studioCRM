import { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { dateFormatLabel, formatDateOnly, isIsoDate, parseDisplayDate } from '@erp/shared';
import { useDisplayFormats } from '@/lib/settings';
import { cx } from '@/lib/format';

/**
 * The app's date field. Shows and accepts the date in the tenant's Date Format setting; the
 * value it reports is always the canonical "YYYY-MM-DD" (or '' when blank).
 *
 * Why not a plain <input type="date">: the browser renders that field in the OPERATING
 * SYSTEM's locale, so an en-US Windows shows 09/25/2026 whatever Settings says, and no
 * attribute can change that. Here the visible text is ours. The native control is kept only as
 * the calendar pop-up (`showPicker()`), which is a month grid with no date text to misorder.
 *
 * While the operator is typing, text that is not yet a real date is reported as typed, so a
 * form can refuse it with `validDate` rather than silently blanking it.
 *
 * Keyboard: type the date (any of / - . as separators, 1- or 2-digit day and month); Alt+↓ or
 * F4 opens the calendar. The calendar button is skipped by Tab so the form's tab order stays
 * field to field.
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
}>(function DateInput({ value, onChange, onBlur, size, disabled, readOnly, className, ...rest }, ref) {
  const { dateFormat } = useDisplayFormats();
  const picker = useRef<HTMLInputElement>(null);
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

  const openCalendar = () => {
    if (locked) return;
    const el = picker.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  };

  return (
    <div className={cx('relative', className)}>
      <input
        ref={ref}
        {...rest}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={dateFormatLabel(dateFormat)}
        value={shown}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={!!v && !isIsoDate(v)}
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
            openCalendar();
          }
        }}
        className={cx('input pr-8', size === 'sm' && 'input-sm')}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={locked}
        onClick={openCalendar}
        aria-label="Open calendar"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-gray-400 transition-colors duration-150 hover:text-primary disabled:pointer-events-none"
      >
        <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
      </button>
      {/* The calendar pop-up only. Invisible, unfocusable, and never the value's source of truth. */}
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={isIsoDate(v) ? v : ''}
        onChange={(e) => {
          setTyping(null);
          onChange(e.target.value);
        }}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />
    </div>
  );
});

/** react-hook-form rule for a DateInput: blank is left to `required`, anything else must be a real date. */
export const validDate = (v: unknown) => !v || isIsoDate(v) || 'Enter a valid date';
