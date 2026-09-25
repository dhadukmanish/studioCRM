// Dates and times are formatted by `useDateFormatters()` in lib/settings.ts, which follows the
// tenant's Date Format setting. Do not add a hard-coded date formatter here.
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
