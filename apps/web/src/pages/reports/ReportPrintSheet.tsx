import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { INVOICE_COLORS } from '@erp/shared';
import { useCompanyLogo, useCompanyProfile, useDateFormatters } from '@/lib/settings';

/**
 * A report on paper: rendered straight under <body> as a `.print-root`, so printing shows only
 * this — never the app shell, and never the phone card layout (index.css). Like the invoice and the
 * receipt, paper ignores the app theme and draws with `INVOICE_COLORS`. The company name and logo
 * come from the company profile. It prints the WHOLE filtered result the caller fetched.
 *
 * `ReportSheet` is the paper itself; the Preview shows exactly that, so what is previewed is what prints.
 */
export interface ReportPrintData {
  title: string;
  /** Scope and filters, one line. */
  caption: string;
  /** Headline figures for the whole result. */
  summary: { label: string; value: string }[];
  headers: string[];
  /** Right-aligned (numeric) columns, by index. */
  numeric: number[];
  /** Columns never wrapped (dates, numbers, mobiles), by index. */
  nowrap?: number[];
  rows: string[][];
  totals: string[];
  /** Rows that open a new group (the Detailed tab's bills) get a rule above them. */
  groupStart?: boolean[];
  landscape?: boolean;
}

/** The sheet's printable width — A4 less the 12mm margins — for an on-screen preview of the same page. */
export const sheetWidth = (landscape?: boolean) => (landscape ? '273mm' : '186mm');

/** The paper — printed by `ReportPrintSheet`, shown as is by the Preview. */
export function ReportSheet({ data }: { data: ReportPrintData }) {
  const company = useCompanyProfile().data;
  const logo = useCompanyLogo(company?.id, company?.logo?.version).data;
  const fmt = useDateFormatters();
  const c = INVOICE_COLORS;
  const cell = (i: number): CSSProperties => ({ borderBottom: `0.5pt solid ${c.line}`, padding: '2.5pt 4pt', textAlign: data.numeric.includes(i) ? 'right' : 'left', whiteSpace: data.nowrap?.includes(i) ? 'nowrap' : undefined, fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' });
  const rowCell = (i: number, j: number): CSSProperties => (j > 0 && data.groupStart?.[j] ? { ...cell(i), borderTop: `0.9pt solid ${c.rule}` } : cell(i));

  return (
    <div style={{ background: c.paper, color: c.text, fontSize: '8.5pt', lineHeight: 1.35 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8pt', borderBottom: `1.2pt solid ${c.rule}`, paddingBottom: '6pt', marginBottom: '6pt' }}>
        {logo && <img src={logo} alt="" style={{ height: '30pt', width: '30pt', objectFit: 'contain' }} />}
        <div style={{ flex: 1 }}>
          {company?.name && <div style={{ fontSize: '12pt', fontWeight: 600 }}>{company.name}</div>}
          <div style={{ fontSize: '11pt' }}>{data.title}</div>
        </div>
        <div style={{ textAlign: 'right', color: c.muted, fontSize: '7.5pt' }}>Printed {fmt.stamp(new Date().toISOString())}</div>
      </div>
      <div style={{ color: c.muted, marginBottom: '6pt' }}>{data.caption}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14pt', marginBottom: '8pt' }}>
        {data.summary.map((s) => (
          <div key={s.label}>
            <span style={{ color: c.muted }}>{s.label}: </span>
            <span style={{ fontWeight: 600 }}>{s.value}</span>
          </div>
        ))}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: c.headFill }}>
            {data.headers.map((h, i) => (
              <th key={h} style={{ ...cell(i), fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, j) => (
            <tr key={j}>
              {r.map((v, i) => (
                <td key={i} style={rowCell(i, j)}>{v}</td>
              ))}
            </tr>
          ))}
          <tr>
            {data.totals.map((v, i) => (
              <td key={i} style={{ ...cell(i), fontWeight: 600, borderBottom: 'none', borderTop: `1pt solid ${c.rule}` }}>{v}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** A report on paper, under <body> as a `.print-root` — the only thing `window.print()` shows. */
export function ReportPrintSheet({ data }: { data: ReportPrintData }) {
  return createPortal(
    <div className="print-root">
      <style>{`@page { size: A4 ${data.landscape ? 'landscape' : 'portrait'}; margin: 12mm; } .print-root thead { display: table-header-group; } .print-root tr { break-inside: avoid; }`}</style>
      <ReportSheet data={data} />
    </div>,
    document.body,
  );
}
