import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { INVOICE_COLORS, type InvoiceRenderModel } from '@erp/shared';
import { useCompanyLogo } from '@/lib/settings';

/**
 * The browser renderer of an `InvoiceRenderModel` — the same model the PDF draws, in the same
 * units (PDF points, written as CSS `pt`), with the same section order, visibility and labels.
 * It decides nothing: every section, column and value comes from the model.
 *
 * A business document, so it deliberately ignores the app theme and uses the fixed
 * INVOICE_COLORS (no dark mode on paper). The screen shows one continuous sheet; the PDF is
 * where pages are split (docs/INVOICE_TEMPLATES.md).
 */
const pt = (n: number) => `${n}pt`;
const FONT = '"Noto Sans", "Segoe UI", Roboto, Arial, sans-serif';
const JUSTIFY = { LEFT: 'flex-start', CENTER: 'center', RIGHT: 'flex-end' } as const;
const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' } as const;

export function InvoiceDocument({ model, logoSrc, print }: { model: InvoiceRenderModel; logoSrc?: string | null; print?: boolean }) {
  const s = model.style;
  const c = INVOICE_COLORS;
  const wrapWeight = model.columns.reduce((t, col) => t + (col.wrap ? col.weight : 0), 0) || 1;
  const totalsW = s.totalsWidth;
  const grid = s.tableBorders === 'grid';
  const cellBorder = grid ? `0.5pt solid ${c.line}` : undefined;
  const lineH = s.lineHeight;
  // Same rule as the PDF: numbers, serial and HSN never wrap and take their natural width
  // (width 1% under auto layout); only the text columns wrap, sharing the rest by weight.
  const cell = (col: InvoiceRenderModel['columns'][number]): CSSProperties => ({
    padding: `${pt(s.cellPadY)} ${pt(s.cellPadX)}`,
    textAlign: col.align,
    verticalAlign: 'top',
    border: cellBorder,
    ...(col.wrap ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: `${(col.weight / wrapWeight) * 100}%` } : { whiteSpace: 'nowrap', width: '1%' }),
  });
  const label: CSSProperties = { fontSize: pt(s.smallSize), fontWeight: 600, color: c.muted, letterSpacing: '0.02em' };
  const field = (labelW: number) => ({ display: 'grid', gridTemplateColumns: `${pt(labelW)} 1fr`, fontSize: pt(s.fontSize), lineHeight: lineH, marginBottom: pt(1) });

  return (
    <div
      className="invoice-document"
      style={{
        position: 'relative',
        width: print ? undefined : pt(s.pageWidth),
        minHeight: print ? undefined : pt(s.pageHeight),
        padding: print ? 0 : pt(s.margin),
        boxSizing: 'border-box',
        background: c.paper,
        color: c.text,
        fontFamily: FONT,
        fontSize: pt(s.fontSize),
        lineHeight: lineH,
      }}
    >
      {model.isSample && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', overflow: 'hidden' }}>
          <span style={{ fontSize: pt(96), fontWeight: 700, color: c.sample, opacity: 0.08, transform: 'rotate(-35deg)' }}>SAMPLE</span>
        </div>
      )}

      {/* Header: logo row, then the company block — each aligned as the template says. */}
      {model.header.logo && logoSrc && (
        <div style={{ display: 'flex', justifyContent: JUSTIFY[model.header.logo.alignment], marginBottom: pt(6) }}>
          <img src={logoSrc} alt="" style={{ maxWidth: pt(s.logoMaxWidth), maxHeight: pt(s.logoMaxHeight), objectFit: 'contain', display: 'block' }} />
        </div>
      )}
      <div style={{ textAlign: TEXT_ALIGN[model.header.alignment] }}>
        {model.header.companyName && <div style={{ fontSize: pt(s.companySize), fontWeight: 600, lineHeight: lineH }}>{model.header.companyName}</div>}
        {model.header.lines.map((l, i) => (
          <div key={i} style={{ fontSize: pt(s.smallSize), color: c.muted, lineHeight: lineH }}>{l}</div>
        ))}
      </div>
      <div style={{ borderTop: `${s.preset === 'COMPACT' ? 0.5 : 1}pt solid ${c.rule}`, marginTop: pt(4), marginBottom: pt(s.sectionGap * 0.8) }} />

      <div style={{ fontSize: pt(s.titleSize), fontWeight: 600, textTransform: 'uppercase', textAlign: model.header.alignment === 'CENTER' ? 'center' : 'left', lineHeight: lineH, marginBottom: pt(4) }}>{model.title}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: pt(16), marginBottom: pt(s.sectionGap) }}>
        {[
          { title: model.labels.billedTo, fields: model.customer, labelW: s.customerLabelWidth },
          { title: model.labels.details, fields: model.meta, labelW: s.metaLabelWidth },
        ].map((b) => (
          <div key={b.title}>
            <div style={{ ...label, marginBottom: pt(2) }}>{b.title}</div>
            {b.fields.map((f) => (
              <div key={f.label} style={field(b.labelW)}>
                <span style={{ fontSize: pt(s.smallSize), color: c.muted }}>{f.label}</span>
                <span style={{ fontWeight: f.strong ? 600 : 400, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{f.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto', fontSize: pt(s.fontSize) }}>
        <thead style={{ display: 'table-header-group' }}>
          <tr style={{ background: s.headerFill ? c.headFill : undefined, borderTop: `${grid ? 0.5 : 0.8}pt solid ${grid ? c.line : c.rule}`, borderBottom: `${grid ? 0.5 : 0.8}pt solid ${grid ? c.line : c.rule}` }}>
            {model.columns.map((col) => (
              <th key={col.key} style={{ ...cell(col), fontSize: pt(s.smallSize), fontWeight: 600 }}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row, r) => (
            <tr key={r} style={{ breakInside: 'avoid', borderBottom: `${!grid && r === model.rows.length - 1 ? 0.8 : 0.5}pt solid ${!grid && r === model.rows.length - 1 ? c.rule : c.line}` }}>
              {row.map((v, i) => (
                <td key={i} style={cell(model.columns[i])}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* GST summary (left) and totals (right), one band — as in the PDF. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: pt(24), marginTop: pt(s.sectionGap), breakInside: 'avoid' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {model.gstSummary && (
            <>
              <div style={{ ...label, marginBottom: pt(2) }}>{model.labels.gstSummary}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: pt(s.smallSize) }}>
                <tbody>
                  {[model.gstSummary.columns, ...model.gstSummary.rows, model.gstSummary.total].map((r, ri, all) => (
                    <tr key={ri} style={{ background: ri === 0 ? c.headFill : undefined, borderTop: ri === 0 ? `0.5pt solid ${c.line}` : undefined, borderBottom: `0.5pt solid ${c.line}`, fontWeight: ri === 0 || ri === all.length - 1 ? 600 : 400 }}>
                      {r.map((v, i) => (
                        <td key={i} style={{ padding: `${pt(Math.max(2, s.cellPadY - 1))} ${pt(s.cellPadX)}`, textAlign: i === 0 ? 'left' : 'right', width: `${s.summaryColumns[i] * 100}%` }}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div style={{ width: pt(totalsW), flexShrink: 0 }}>
          {model.totals.map((t) => (
            <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: pt(t.strong ? s.fontSize + 2 : s.fontSize), fontWeight: t.strong ? 600 : 400, color: t.strong ? c.text : undefined, borderTop: t.strong ? `0.8pt solid ${c.rule}` : undefined, paddingTop: pt(t.strong ? 4 : 1), paddingBottom: pt(1), marginTop: t.strong ? pt(1) : 0 }}>
              <span style={{ color: t.strong ? c.text : c.muted }}>{t.label}</span>
              <span>{t.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: pt(s.sectionGap) }}>
        {model.remark && (
          <div style={{ breakInside: 'avoid', marginBottom: pt(s.sectionGap * 0.6) }}>
            <div style={label}>{model.labels.remark}</div>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{model.remark}</div>
          </div>
        )}
        {model.footer.terms && (
          <div style={{ breakInside: 'avoid', marginBottom: pt(s.sectionGap * 0.6) }}>
            <div style={label}>{model.labels.terms}</div>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: pt(s.smallSize), color: c.muted }}>{model.footer.terms}</div>
          </div>
        )}
        {model.footer.thankYou && <div style={{ textAlign: 'center', whiteSpace: 'pre-wrap', marginBottom: pt(s.sectionGap * 0.6) }}>{model.footer.thankYou}</div>}
        {model.footer.signatory && (
          <div style={{ breakInside: 'avoid', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <div style={{ fontWeight: 600 }}>{model.footer.signatory}</div>
            <div style={{ width: pt(s.signatureLineWidth), borderBottom: `0.5pt solid ${c.line}`, height: pt(26) }} />
            <div style={{ fontSize: pt(s.smallSize), color: c.muted, marginTop: pt(3) }}>{model.labels.signatoryCaption}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Fetches the company logo (Phase 3 service, cached per version) for a model that shows it. */
export function useInvoiceLogo(model?: InvoiceRenderModel | null) {
  const logo = model?.header.logo;
  return useCompanyLogo(logo?.companyId, logo?.version).data ?? null;
}

/**
 * An A4 sheet scaled to the width it is given, keeping the A4 proportions. `scale` fixes it
 * (thumbnails); otherwise it fits its container, capped at 100%.
 */
export function InvoiceSheet({ model, logoSrc, scale: fixed, maxScale = 1, className }: { model: InvoiceRenderModel; logoSrc?: string | null; scale?: number; maxScale?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(fixed ?? 0.5);
  const pagePx = (model.style.pageWidth * 96) / 72;
  useEffect(() => {
    if (fixed !== undefined || !box.current) return;
    const el = box.current;
    const ro = new ResizeObserver(() => setFit(Math.min(maxScale, el.clientWidth / pagePx)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed, maxScale, pagePx]);
  const scale = fixed ?? fit;
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState((model.style.pageHeight * 96) / 72);
  useEffect(() => {
    if (!inner.current) return;
    const el = inner.current;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={className}>
      <div style={{ width: pagePx * scale, height: h * scale, margin: '0 auto', overflow: 'hidden' }}>
        <div ref={inner} style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: pagePx, boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>
          <InvoiceDocument model={model} logoSrc={logoSrc} />
        </div>
      </div>
    </div>
  );
}

/**
 * The print copy: rendered straight under <body>, outside the app, so printing shows only the
 * invoice — no sidebar, top bar or controls (see `.invoice-print-root` in index.css). The page
 * margin is the template's.
 */
export function InvoicePrintRoot({ model, logoSrc }: { model: InvoiceRenderModel; logoSrc?: string | null }) {
  return createPortal(
    <div className="invoice-print-root">
      <style>{`@page { size: A4 portrait; margin: ${model.style.margin}pt; }`}</style>
      <InvoiceDocument model={model} logoSrc={logoSrc} print />
    </div>,
    document.body,
  );
}
