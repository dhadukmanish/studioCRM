export function fmtDate(d?: string | Date | null, withTime = false) {
  if (!d) return '-';
  const x = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return String(d);
  const dd = String(x.getDate()).padStart(2, '0');
  const mm = String(x.getMonth() + 1).padStart(2, '0');
  const yyyy = x.getFullYear();
  if (!withTime) return `${dd}-${mm}-${yyyy}`;
  let h = x.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${dd}-${mm}-${yyyy} ${String(h).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')} ${ampm}`;
}
/**
 * A date-only value ("2026-09-23") in the app's display convention, WITHOUT parsing it into a
 * Date first: `new Date('2026-09-23')` is UTC midnight, which renders as the previous day in
 * any timezone behind UTC. A business date must never shift.
 */
export function fmtDateOnly(d?: string | null) {
  if (!d) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
}
/** "14:30" / "14:30:00" -> "02:30 PM". Clock time only — no date and no timezone involved. */
export function fmtTime(t?: string | null) {
  if (!t) return '-';
  const m = /^(\d{2}):(\d{2})/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  return `${String(h % 12 || 12).padStart(2, '0')}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}
/**
 * Today as "YYYY-MM-DD" in the browser's own timezone — which is the studio's timezone, since
 * the app is used at the studio. Deliberately not `toISOString().slice(0, 10)`: that is the UTC
 * date, and in India it is still yesterday until 05:30.
 */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtMoney(n: number | string | null | undefined, symbol = '₹', decimals = 2) {
  const v = Number(n ?? 0);
  return `${symbol}${v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
export function fmtNum(n: number | string | null | undefined, decimals = 2) {
  return Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
