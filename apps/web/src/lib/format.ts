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
export function fmtMoney(n: number | string | null | undefined, symbol = '₹', decimals = 2) {
  const v = Number(n ?? 0);
  return `${symbol}${v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
export function fmtNum(n: number | string | null | undefined, decimals = 2) {
  return Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
