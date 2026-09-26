import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { INVOICE_COLORS, PAYMENT_MODE_LABELS, RECEIPT_STATUS_LABELS, type CompanyProfile, type ReceiptRecord } from '@erp/shared';
import { fmtMoney } from '@/lib/format';
import { useCompanyLogo, useDateFormatters } from '@/lib/settings';

/**
 * The paper copy of a receipt, rendered straight under <body> so printing shows only this —
 * never the app shell (see `.print-root` in index.css). Paper ignores the app theme, so like the
 * invoice it draws with the fixed `INVOICE_COLORS`, never theme tokens: a dark theme must still
 * print dark ink on white. Company name and logo come from the company profile.
 */
export function ReceiptPrintCopy({ receipt, company }: { receipt: ReceiptRecord; company: CompanyProfile | null | undefined }) {
  const fmt = useDateFormatters();
  const logo = useCompanyLogo(company?.id, company?.logo?.version).data;
  const c = INVOICE_COLORS;
  const cell: CSSProperties = { borderBottom: `1px solid ${c.line}`, padding: '4pt 6pt', textAlign: 'left' };
  const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const address = company ? [company.addressLine1, company.addressLine2, [company.city, company.state, company.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const cancelled = receipt.status === 'CANCELLED';

  const row = (label: string, value: string) => (
    <tr>
      <td style={{ padding: '2pt 0', color: c.muted, width: '38%' }}>{label}</td>
      <td style={{ padding: '2pt 0' }}>{value}</td>
    </tr>
  );

  return createPortal(
    <div className="print-root" style={{ background: c.paper, color: c.text, fontSize: '10pt', lineHeight: 1.4 }}>
      <style>{'@page { size: A5 portrait; margin: 14mm; }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10pt', borderBottom: `1.5pt solid ${c.rule}`, paddingBottom: '8pt', marginBottom: '10pt' }}>
        {logo && <img src={logo} alt="" style={{ height: '40pt', width: '40pt', objectFit: 'contain' }} />}
        <div style={{ flex: 1 }}>
          {company?.name && <div style={{ fontSize: '14pt', fontWeight: 600 }}>{company.name}</div>}
          {address && <div style={{ color: c.muted, fontSize: '8.5pt' }}>{address}</div>}
          {company?.phone && <div style={{ color: c.muted, fontSize: '8.5pt' }}>{company.phone}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '13pt', fontWeight: 600 }}>RECEIPT</div>
          {cancelled && <div style={{ color: c.sample, fontWeight: 600 }}>{RECEIPT_STATUS_LABELS.CANCELLED.toUpperCase()}</div>}
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10pt' }}>
        <tbody>
          {row('Receipt No.', String(receipt.receiptNumber))}
          {row('Date', fmt.date(receipt.receiptDate))}
          {row('Received from', `${receipt.customerName} (${receipt.mobileNumber})`)}
          {row('Mode', `${PAYMENT_MODE_LABELS[receipt.paymentMode]} — ${receipt.accountName}`)}
          {receipt.remark && row('Remark', receipt.remark)}
          {cancelled && row('Cancelled', [fmt.stamp(receipt.cancelledAt), receipt.cancelReason].filter(Boolean).join(' — '))}
        </tbody>
      </table>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: c.headFill }}>
            <th style={cell}>Bill</th>
            <th style={cell}>Bill Date</th>
            <th style={num}>Bill Total</th>
            <th style={num}>Amount Received</th>
          </tr>
        </thead>
        <tbody>
          {receipt.allocations.map((a) => (
            <tr key={a.id}>
              <td style={cell}>{a.bookNumber}/{a.billNumber}</td>
              <td style={cell}>{fmt.date(a.billDate)}</td>
              <td style={num}>{fmtMoney(a.grandTotal)}</td>
              <td style={num}>{fmtMoney(a.amount)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ ...cell, fontWeight: 600, borderBottom: 'none' }} colSpan={3}>Total received</td>
            <td style={{ ...num, fontWeight: 600, borderBottom: 'none' }}>{fmtMoney(receipt.amount)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: '36pt', display: 'flex', justifyContent: 'flex-end', color: c.muted, fontSize: '8.5pt' }}>
        <div style={{ borderTop: `1px solid ${c.line}`, paddingTop: '3pt', minWidth: '120pt', textAlign: 'center' }}>Authorised signatory</div>
      </div>
    </div>,
    document.body,
  );
}
