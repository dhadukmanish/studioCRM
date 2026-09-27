/**
 * Calendar arithmetic on business dates ("YYYY-MM-DD") for the date picker.
 *
 * A business date is a calendar day, not an instant, so nothing here goes through local time or
 * `toISOString()`. Where day arithmetic needs a Date, it is built and read back in UTC only
 * (`Date.UTC` in, `getUTC*` out), which has no timezone offset to shift the day by.
 */

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
/** The week starts on Sunday, as a printed Indian calendar does. */
export const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export const isoOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const partsOf = (iso: string) => ({ y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) });

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function fromUtc(t: number) {
  const d = new Date(t);
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `iso` moved by whole days — across month and year ends, 29 February included. */
export function addDays(iso: string, n: number) {
  const { y, m, d } = partsOf(iso);
  return fromUtc(Date.UTC(y, m - 1, d + n));
}

/** `iso` moved by whole months, the day clamped to the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, n: number) {
  const { y, m, d } = partsOf(iso);
  const idx = y * 12 + (m - 1) + n;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  return isoOf(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (iso: string) => {
  const { y, m, d } = partsOf(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The 42 days (six whole weeks, Sunday first) a month view shows for month `m` of year `y`. */
export function monthGrid(y: number, m: number): string[] {
  const first = isoOf(y, m, 1);
  const start = addDays(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const between = (v: string, from?: string, to?: string) => (!from || v >= from) && (!to || v <= to);
