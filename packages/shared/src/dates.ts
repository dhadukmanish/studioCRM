/**
 * Date and time DISPLAY rules — the one place the app turns a stored date into text and back.
 *
 * Storage never changes with the setting: a business date is always the canonical
 * "YYYY-MM-DD" on the wire and in the database, a clock time is "HH:mm[:ss]", and a timestamp
 * is an ISO instant. Only what the operator SEES follows the tenant's `dateFormat` /
 * `timeFormat` (app_settings). See docs/SETTINGS.md.
 *
 * A date-only value is never parsed into a JavaScript Date: `new Date('2026-09-25')` is UTC
 * midnight, which is still the 24th anywhere behind UTC. These functions work on the digits.
 */

/** The display orders Settings offers. The tokens are the ones the tenant's settings JSON already stores. */
export const DATE_FORMATS = ['dd-MM-yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const DEFAULT_DATE_FORMAT: DateFormat = 'dd-MM-yyyy';

export const TIME_FORMATS = ['hh:mm tt', 'HH:mm'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];
export const DEFAULT_TIME_FORMAT: TimeFormat = 'hh:mm tt';

/** A stored or unknown value narrowed to a supported format — anything unrecognised falls back to the default. */
export const toDateFormat = (v: unknown): DateFormat => ((DATE_FORMATS as readonly unknown[]).includes(v) ? (v as DateFormat) : DEFAULT_DATE_FORMAT);
export const toTimeFormat = (v: unknown): TimeFormat => ((TIME_FORMATS as readonly unknown[]).includes(v) ? (v as TimeFormat) : DEFAULT_TIME_FORMAT);

/** "dd/MM/yyyy" -> "DD/MM/YYYY": what a date field shows as its placeholder and the Settings list shows as a label. */
export const dateFormatLabel = (f: DateFormat) => f.toUpperCase();

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function daysInMonth(y: number, m: number) {
  return m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function isRealDate(y: number, m: number, d: number) {
  return y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** True only for an exact "YYYY-MM-DD" that names a real calendar day (so 2026-02-29 is false, 2028-02-29 true). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return !!m && isRealDate(+m[1], +m[2], +m[3]);
}

function arrange(format: DateFormat, y: string, m: string, d: string) {
  switch (format) {
    case 'dd/MM/yyyy': return `${d}/${m}/${y}`;
    case 'MM/dd/yyyy': return `${m}/${d}/${y}`;
    case 'yyyy-MM-dd': return `${y}-${m}-${d}`;
    default: return `${d}-${m}-${y}`;
  }
}

/**
 * A business date ("2026-09-25") in the tenant's display order. Blank -> "-". A value that is
 * not a real "YYYY-MM-DD" is returned untouched rather than guessed at, so bad data stays
 * visible instead of turning into a plausible wrong date.
 */
export function formatDateOnly(value: string | null | undefined, format: DateFormat = DEFAULT_DATE_FORMAT): string {
  if (!value) return '-';
  if (!isIsoDate(value)) return value;
  return arrange(format, value.slice(0, 4), value.slice(5, 7), value.slice(8, 10));
}

/** "14:30" / "14:30:00" -> "02:30 PM" or "14:30". A clock time only — no date and no timezone involved. */
export function formatClockTime(value: string | null | undefined, format: TimeFormat = DEFAULT_TIME_FORMAT): string {
  if (!value) return '-';
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (!m) return value;
  const h = Number(m[1]);
  return format === 'HH:mm' ? `${m[1]}:${m[2]}` : `${pad(h % 12 || 12)}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * A real instant (created_at, updated_at, last login) in the viewer's local time, date in the
 * tenant's order, optionally followed by the clock time. Unlike a business date this one IS a
 * point in time, so converting it to local time is correct.
 */
export function formatTimestamp(
  value: string | Date | null | undefined,
  opts: { dateFormat?: DateFormat; timeFormat?: TimeFormat; withTime?: boolean } = {},
): string {
  if (!value) return '-';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  const date = arrange(opts.dateFormat ?? DEFAULT_DATE_FORMAT, pad(d.getFullYear(), 4), pad(d.getMonth() + 1), pad(d.getDate()));
  return opts.withTime ? `${date} ${formatClockTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`, opts.timeFormat)}` : date;
}

/**
 * What an operator typed, read in the tenant's order, as canonical "YYYY-MM-DD" — or null when
 * it is not a real date. Forgiving about the separator (/ - . or space) and single-digit
 * day/month ("5/9/2026"), strict about a four-digit year and about the day existing. A value
 * that starts with a four-digit year is read as year-month-day whatever the setting, so a
 * pasted ISO date always works.
 */
export function parseDisplayDate(text: string | null | undefined, format: DateFormat = DEFAULT_DATE_FORMAT): string | null {
  const parts = (text ?? '').trim().split(/[\/\-.\s]+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  let y: string, m: string, d: string;
  if (parts[0].length === 4) [y, m, d] = parts;
  else if (format === 'MM/dd/yyyy') [m, d, y] = parts;
  else if (format === 'yyyy-MM-dd') return null;
  else [d, m, y] = parts;
  if (y.length !== 4 || m.length > 2 || d.length > 2) return null;
  if (!isRealDate(+y, +m, +d)) return null;
  return `${y}-${pad(+m)}-${pad(+d)}`;
}
