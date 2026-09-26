/**
 * CSV for exports — the one place a spreadsheet file is built.
 *
 * Formula injection: a cell whose text begins with `=`, `+`, `-`, `@`, a tab or a carriage return
 * (after any leading spaces) is run as a formula by Excel / Sheets / LibreOffice — a customer named
 * `=HYPERLINK("http://evil","click")` would become a live link. Such text is prefixed with a single
 * quote, which the spreadsheet shows as plain text (OWASP's recommendation).
 *
 * Numbers the server itself formatted (money, counts) are passed as `csvNumber(...)` and written
 * as-is: they are not user text, and must stay numbers the spreadsheet can add up.
 *
 * The file is UTF-8 with a byte-order mark, so Excel opens Gujarati / Hindi / ₹ correctly, and uses
 * CRLF line ends (RFC 4180).
 */

const FORMULA_START = /^\s*[=+\-@\t\r]/;

/** A server-formatted number — written unquoted and never treated as formula text. */
export interface CsvNumber {
  readonly csvNumber: string;
}
export const csvNumber = (n: number, decimals = 2): CsvNumber => ({ csvNumber: n.toFixed(decimals) });
export const csvInteger = (n: number): CsvNumber => ({ csvNumber: String(Math.trunc(n)) });

export type CsvValue = string | CsvNumber | null | undefined;

export function csvCell(v: CsvValue): string {
  if (v == null) return '';
  if (typeof v === 'object') return v.csvNumber;
  let s = String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}
