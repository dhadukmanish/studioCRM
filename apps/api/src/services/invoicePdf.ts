import { PDFDocument, rgb, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { INVOICE_COLORS, type InvoiceCellAlign, type InvoiceField, type InvoiceRenderModel } from '@erp/shared';
import { AppError } from '../lib/errors';
import { PdfText, UnprintableTextError, unprintableCharacters, type Weight } from './invoicePdfText';

/**
 * Invoice PDF renderer (docs/INVOICE_TEMPLATES.md, "PDF").
 *
 * Draws an `InvoiceRenderModel` — already decided and formatted by the shared builder — onto A4
 * pages with pdf-lib: real, searchable PDF text in English, Gujarati and Hindi (Devanagari),
 * shaped by HarfBuzz (`invoicePdfText.ts`), in embedded Noto fonts; no browser, no native binary,
 * nothing outside the bundle. It lays out and paginates itself: the table header repeats on every
 * page, a row is never split across pages, and the totals / summary / footer blocks each move to a
 * new page whole rather than overlap. Text it cannot print is refused up front, never boxed.
 *
 * Deterministic: the same model and logo give byte-identical output (fixed document dates and
 * font names).
 *
 * It never computes a figure. It measures text and places it; every value is the model's string.
 */

/* ------------------------------------------------------- printable text -- */

/** Every string the PDF prints, with the name of the invoice area it comes from (for the error message). */
function printedText(model: InvoiceRenderModel): [area: string, text: string][] {
  // The title is drawn upper-cased at the top and as typed in the page footer: check both forms.
  const out: [string, string][] = [['Title', model.title], ['Title', model.title.toUpperCase()], ['Bill number', model.documentLabel]];
  if (model.header.companyName) out.push(['Company name', model.header.companyName]);
  model.header.lines.forEach((l) => out.push(['Company details', l]));
  Object.values(model.labels).forEach((l) => out.push(['Invoice headings', l]));
  for (const f of [...model.customer, ...model.meta]) out.push([f.label, f.label], [f.label, f.value]);
  model.columns.forEach((c) => out.push(['Table headings', c.label]));
  model.rows.forEach((r, i) => r.forEach((cell, j) => out.push([`Line ${i + 1}, ${model.columns[j]?.label ?? ''}`, cell])));
  model.totals.forEach((t) => out.push([t.label, t.label], [t.label, t.value]));
  if (model.gstSummary) [model.gstSummary.columns, ...model.gstSummary.rows, model.gstSummary.total].forEach((r) => r.forEach((c) => out.push(['GST summary', c])));
  if (model.remark) out.push(['Remark', model.remark]);
  if (model.footer.terms) out.push(['Terms', model.footer.terms]);
  if (model.footer.thankYou) out.push(['Thank-you note', model.footer.thankYou]);
  if (model.footer.signatory) out.push(['Signatory', model.footer.signatory]);
  return out;
}

/**
 * The characters of an invoice the PDF fonts cannot draw — Tamil, emoji, Chinese... (English,
 * Gujarati, Hindi/Devanagari and ₹ are covered). Grouped by the invoice area they appear in.
 */
export function unprintableText(model: InvoiceRenderModel): { area: string; characters: string[] }[] {
  const byArea = new Map<string, Set<string>>();
  for (const [area, text] of printedText(model)) {
    for (const ch of unprintableCharacters(clean(text))) {
      if (!byArea.has(area)) byArea.set(area, new Set());
      byArea.get(area)!.add(ch);
    }
  }
  return [...byArea].map(([area, chars]) => ({ area, characters: [...chars] }));
}

/** The PDF never prints a box or a blank for a character it cannot draw: it refuses, and says where. */
function unprintableError(problems: { area: string; characters: string[] }[]) {
  const where = problems.slice(0, 3).map((p) => `${p.characters.join(' ')} in ${p.area}`).join('; ');
  return new AppError(
    'INVOICE_UNPRINTABLE_TEXT',
    `This invoice contains characters that the PDF cannot print yet (${where}${problems.length > 3 ? '; …' : ''}). ` +
      'The PDF supports English, Gujarati and Hindi text and ₹. Change that text, or print from the preview instead.',
    422,
    problems,
  );
}

/* ---------------------------------------------------------------- helpers -- */

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = { text: hex(INVOICE_COLORS.text), muted: hex(INVOICE_COLORS.muted), line: hex(INVOICE_COLORS.line), rule: hex(INVOICE_COLORS.rule), headFill: hex(INVOICE_COLORS.headFill), sample: hex(INVOICE_COLORS.sample) };

/** Replaces characters that are not printable in a PDF text run (control chars). Tabs become spaces. */
const clean = (s: string) => s.replace(/\t/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '');

export interface InvoiceLogo { data: Uint8Array; contentType: string }
export interface RenderPdfOptions { /** Written as the PDF's creation/modification date — pass the bill's updatedAt for stable output. */ date?: Date }

/**
 * Renders the invoice. The logo is optional: absent, or in a format pdf-lib cannot embed, the
 * header simply has no image. Text no embedded font can draw is refused (422) before anything is
 * drawn; the shaper's own glyph check is the backstop.
 */
export async function renderInvoicePdf(model: InvoiceRenderModel, logo: InvoiceLogo | null, opts: RenderPdfOptions = {}): Promise<Uint8Array> {
  const problems = unprintableText(model);
  if (problems.length) throw unprintableError(problems);
  try {
    return await render(model, logo, opts);
  } catch (e) {
    if (e instanceof UnprintableTextError) throw unprintableError([{ area: 'the invoice', characters: e.characters }]);
    throw e;
  }
}

async function render(model: InvoiceRenderModel, logo: InvoiceLogo | null, opts: RenderPdfOptions): Promise<Uint8Array> {
  const s = model.style;
  const doc = await PDFDocument.create();
  const tx = await PdfText.create(doc);
  const regular: Weight = 'regular';
  const bold: Weight = 'bold';

  const when = opts.date ?? new Date(0);
  doc.setTitle(`${model.title} ${model.documentLabel}`);
  doc.setAuthor(model.header.companyName ?? '');
  doc.setCreator('StudioCRM');
  doc.setProducer('StudioCRM');
  doc.setCreationDate(when);
  doc.setModificationDate(when);

  let image: PDFImage | null = null;
  if (logo && model.header.logo) {
    // WebP cannot be embedded by pdf-lib; the browser converts WebP uploads to PNG, so a stored
    // WebP can only come from an old or direct API upload — it is skipped, not faked. A PNG/JPEG
    // that passed the magic-byte check but that pdf-lib cannot decode is skipped the same way:
    // one bad logo must not make every invoice of the tenant fail.
    try {
      if (logo.contentType === 'image/png') image = await doc.embedPng(logo.data);
      else if (logo.contentType === 'image/jpeg') image = await doc.embedJpg(logo.data);
    } catch {
      image = null;
    }
  }

  const W = s.pageWidth;
  const H = s.pageHeight;
  const M = s.margin;
  const contentW = W - 2 * M;
  const footerReserve = s.smallSize * 2.4;
  const bottom = M + footerReserve;
  const lh = (size: number) => size * s.lineHeight;

  // Measured from the same HarfBuzz shaping that draws the text.
  const width = (text: string, size: number, font: Weight) => tx.width(text, size, font);

  /** Word-wraps to a width at word boundaries; an over-long word breaks only between clusters. Honours explicit line breaks. */
  const wrap = (text: string, size: number, font: Weight, maxW: number): string[] =>
    // Split into lines BEFORE cleaning: `clean` drops control characters, and \n is one.
    text.replace(/\r\n?/g, '\n').split('\n').map(clean).flatMap((para) => tx.wrapParagraph(para, size, font, maxW));

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0; // distance from the TOP of the page to the next free line
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = M;
    if (model.isSample) tx.draw(page, 'SAMPLE', W / 2 - 150, H / 2 - 60, 96, bold, C.sample, { opacity: 0.08, rotate: 35 });
  };
  const room = () => H - bottom - y;

  /** Draws one line of text with its TOP at `top`, aligned inside [x, x + w]. */
  const text = (str: string, x: number, top: number, w: number, size: number, font: Weight, color: RGB, align: InvoiceCellAlign | 'LEFT' | 'CENTER' | 'RIGHT' = 'left') => {
    const t = clean(str);
    const tw = width(t, size, font);
    const a = align.toLowerCase();
    const left = a === 'right' ? x + w - tw : a === 'center' ? x + (w - tw) / 2 : x;
    tx.draw(page, t, left, H - top - size * 0.95, size, font, color);
  };
  const hline = (x1: number, x2: number, top: number, color: RGB, thickness = 0.5) => page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness, color });
  const vline = (x: number, top: number, bot: number, color: RGB, thickness = 0.5) => page.drawLine({ start: { x, y: H - top }, end: { x, y: H - bot }, thickness, color });

  newPage();

  /* ---- header: logo row, company block (stacked, each aligned as configured) ---- */
  if (image && model.header.logo) {
    const scale = Math.min(s.logoMaxWidth / image.width, s.logoMaxHeight / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    const a = model.header.logo.alignment;
    const x = a === 'RIGHT' ? M + contentW - w : a === 'CENTER' ? M + (contentW - w) / 2 : M;
    page.drawImage(image, { x, y: H - y - h, width: w, height: h });
    y += h + 6;
  }
  const ha = model.header.alignment;
  if (model.header.companyName) {
    for (const l of wrap(model.header.companyName, s.companySize, bold, contentW)) {
      text(l, M, y, contentW, s.companySize, bold, C.text, ha);
      y += lh(s.companySize);
    }
  }
  for (const line of model.header.lines) {
    for (const l of wrap(line, s.smallSize, regular, contentW)) {
      text(l, M, y, contentW, s.smallSize, regular, C.muted, ha);
      y += lh(s.smallSize);
    }
  }
  y += 4;
  hline(M, M + contentW, y, C.rule, s.preset === 'COMPACT' ? 0.5 : 1);
  y += s.sectionGap * 0.8;

  /* ---- title, then "Billed To" (left) and invoice details (right) ---- */
  text(model.title.toUpperCase(), M, y, contentW, s.titleSize, bold, C.text, ha === 'CENTER' ? 'center' : 'left');
  y += lh(s.titleSize) + 4;

  const colW = contentW / 2 - 8;
  const fieldRows = (fields: InvoiceField[], x: number, w: number, top: number, labelW: number) => {
    let t = top;
    for (const f of fields) {
      const lines = wrap(f.value, s.fontSize, regular, w - labelW);
      text(f.label, x, t, labelW, s.smallSize, regular, C.muted);
      lines.forEach((l, i) => text(l, x + labelW, t + i * lh(s.fontSize), w - labelW, s.fontSize, i === 0 && f.strong ? bold : regular, C.text));
      t += lines.length * lh(s.fontSize) + 1;
    }
    return t;
  };
  text(model.labels.billedTo, M, y, colW, s.smallSize, bold, C.muted);
  text(model.labels.details, M + contentW / 2 + 8, y, colW, s.smallSize, bold, C.muted);
  const blockTop = y + lh(s.smallSize) + 2;
  const leftEnd = fieldRows(model.customer, M, colW, blockTop, s.customerLabelWidth);
  const rightEnd = fieldRows(model.meta, M + contentW / 2 + 8, colW, blockTop, s.metaLabelWidth);
  y = Math.max(leftEnd, rightEnd) + s.sectionGap;

  /* ---- item table ---- */
  // Non-wrapping columns (numbers, serial, HSN) get exactly their widest value — header words
  // included — so a figure is never broken across lines; the text columns share what is left.
  // When that does not fit (many columns, large amounts) the TABLE's type steps down, to 6 pt at
  // the least, rather than breaking a figure; only below that do columns fall back to shares.
  const padX = s.cellPadX;
  const MIN_TEXT = 48;
  const textCols = model.columns.filter((c) => c.wrap).length;
  const wrapWeight = model.columns.reduce((t, c) => t + (c.wrap ? c.weight : 0), 0);
  const layout = (bodySize: number, headSize: number) => {
    const natural = model.columns.map((c, i) =>
      c.wrap ? 0 : Math.max(...c.label.split(/\s+/).map((w) => width(w, headSize, bold)), ...model.rows.map((r) => width(clean(r[i]), bodySize, regular))) + 2 * padX + 1, // +1: measuring slack
    );
    const fixedW = natural.reduce((a, b) => a + b, 0);
    const fits = wrapWeight > 0 ? contentW - fixedW >= MIN_TEXT * textCols : fixedW <= contentW;
    const widths = fits ? model.columns.map((c, i) => (c.wrap ? ((contentW - fixedW) * c.weight) / wrapWeight : natural[i] + (wrapWeight > 0 ? 0 : (contentW - fixedW) / model.columns.length))) : null;
    return widths;
  };
  let bodySize = s.fontSize;
  let headSize = s.smallSize;
  let widths = layout(bodySize, headSize);
  while (!widths && bodySize > 6) {
    bodySize = Math.max(6, bodySize - 0.5);
    headSize = Math.max(5.5, headSize - 0.5);
    widths = layout(bodySize, headSize);
  }
  if (!widths) {
    const totalWeight = model.columns.reduce((t, c) => t + c.weight, 0);
    widths = model.columns.map((c) => (c.weight / totalWeight) * contentW);
  }
  const cellW = widths;
  const xs = cellW.map((_, i) => M + cellW.slice(0, i).reduce((a, b) => a + b, 0));
  const padY = s.cellPadY;

  const headLines = model.columns.map((c, i) => wrap(c.label, headSize, bold, cellW[i] - 2 * padX));
  const headH = Math.max(...headLines.map((l) => l.length)) * lh(headSize) + 2 * padY;

  const drawHead = () => {
    const top = y;
    if (s.headerFill) page.drawRectangle({ x: M, y: H - top - headH, width: contentW, height: headH, color: C.headFill });
    hline(M, M + contentW, top, s.tableBorders === 'grid' ? C.line : C.rule, s.tableBorders === 'grid' ? 0.5 : 0.8);
    model.columns.forEach((c, i) => headLines[i].forEach((l, j) => text(l, xs[i] + padX, top + padY + j * lh(headSize), cellW[i] - 2 * padX, headSize, bold, C.text, c.align)));
    hline(M, M + contentW, top + headH, s.tableBorders === 'grid' ? C.line : C.rule, s.tableBorders === 'grid' ? 0.5 : 0.8);
    if (s.tableBorders === 'grid') [...xs, M + contentW].forEach((x) => vline(x, top, top + headH, C.line));
    y += headH;
  };

  const rowLines = model.rows.map((row) => row.map((cell, i) => wrap(cell, bodySize, regular, cellW[i] - 2 * padX)));
  const rowHeight = (lines: string[][]) => Math.max(1, ...lines.map((l) => l.length)) * lh(bodySize) + 2 * padY;
  // Never leave the header alone at the foot of a page: it starts where its first row fits too.
  if (headH + (rowLines.length ? Math.min(rowHeight(rowLines[0]), 2 * padY + lh(bodySize)) : 0) > room()) newPage();
  drawHead();
  rowLines.forEach((cellLines, r) => {
    const last = r === rowLines.length - 1;
    // A row normally moves to the next page whole. A row taller than a whole page (a very long
    // remark) is the exception: it continues line by line onto the next page instead of running
    // off the bottom — nothing is ever drawn outside the page.
    if (rowHeight(cellLines) > room() && rowHeight(cellLines) <= H - bottom - M - headH) {
      newPage();
      drawHead();
    }
    let from = 0;
    const total = Math.max(1, ...cellLines.map((l) => l.length));
    while (from < total) {
      if (room() < 2 * padY + lh(bodySize)) {
        newPage();
        drawHead();
      }
      const fit = Math.max(1, Math.floor((room() - 2 * padY) / lh(bodySize)));
      const take = Math.min(fit, total - from);
      const segH = take * lh(bodySize) + 2 * padY;
      const top = y;
      cellLines.forEach((lines, i) => lines.slice(from, from + take).forEach((l, j) => text(l, xs[i] + padX, top + padY + j * lh(bodySize), cellW[i] - 2 * padX, bodySize, regular, C.text, model.columns[i].align)));
      const end = from + take >= total;
      hline(M, M + contentW, top + segH, end && last && s.tableBorders === 'rows' ? C.rule : C.line, end && last && s.tableBorders === 'rows' ? 0.8 : 0.5);
      if (s.tableBorders === 'grid') [...xs, M + contentW].forEach((x) => vline(x, top, top + segH, C.line));
      y += segH;
      from += take;
      if (!end) {
        newPage();
        drawHead();
      }
    }
  });
  y += s.sectionGap;

  /* ---- GST summary (left) + totals (right), kept together ---- */
  const totalsW = s.totalsWidth;
  const totalsX = M + contentW - totalsW;
  const totalRowH = (strong: boolean) => lh(strong ? s.fontSize + 2 : s.fontSize) + (strong ? 6 : 2);
  const totalsH = model.totals.reduce((t, r) => t + totalRowH(r.strong), 0) + 4;
  const sum = model.gstSummary;
  const sumW = contentW - totalsW - 24;
  const sumRowH = lh(s.smallSize) + 2 * Math.max(2, padY - 1);
  const sumH = sum ? (sum.rows.length + 2) * sumRowH + lh(s.smallSize) + 4 : 0;
  const bandH = Math.max(totalsH, sumH);
  if (bandH > room()) newPage();
  const bandTop = y;

  if (sum) {
    text(model.labels.gstSummary, M, bandTop, sumW, s.smallSize, bold, C.muted);
    let t = bandTop + lh(s.smallSize) + 2;
    const cw = s.summaryColumns.map((f) => sumW * f);
    const cx = [M, M + cw[0], M + cw[0] + cw[1]];
    const aligns: InvoiceCellAlign[] = ['left', 'right', 'right'];
    const sumRow = (cells: string[], font: Weight, fill: boolean) => {
      if (fill) page.drawRectangle({ x: M, y: H - t - sumRowH, width: sumW, height: sumRowH, color: C.headFill });
      cells.forEach((c, i) => text(c, cx[i] + padX, t + (sumRowH - s.smallSize) / 2, cw[i] - 2 * padX, s.smallSize, font, C.text, aligns[i]));
      t += sumRowH;
      hline(M, M + sumW, t, C.line);
    };
    hline(M, M + sumW, t, C.line);
    sumRow(sum.columns, bold, true);
    sum.rows.forEach((r) => sumRow(r, regular, false));
    sumRow(sum.total, bold, false);
  }

  let t = bandTop;
  for (const r of model.totals) {
    const size = r.strong ? s.fontSize + 2 : s.fontSize;
    const h = totalRowH(r.strong);
    if (r.strong) {
      hline(totalsX, M + contentW, t + 1, C.rule, 0.8);
      t += 4;
    }
    text(r.label, totalsX, t + 1, totalsW / 2, size, r.strong ? bold : regular, r.strong ? C.text : C.muted);
    text(r.value, totalsX + totalsW / 2, t + 1, totalsW / 2, size, r.strong ? bold : regular, C.text, 'right');
    t += h - (r.strong ? 4 : 0);
  }
  y = bandTop + bandH + s.sectionGap;

  /* ---- remark, terms, thank-you, signatory: each block whole on one page when it fits ---- */
  const block = (label: string | null, body: string, size: number, color: RGB, align: InvoiceCellAlign = 'left') => {
    const lines = wrap(body, size, regular, contentW);
    const labelH = label ? lh(s.smallSize) + 2 : 0;
    const h = labelH + lines.length * lh(size) + s.sectionGap * 0.6;
    // Whole block to the next page if it fits there; otherwise start here with at least the label
    // and one line, and carry on line by line (terms can be longer than a page).
    if (h > room() && (h <= H - bottom - M || labelH + lh(size) > room())) newPage();
    if (label) {
      text(label, M, y, contentW, s.smallSize, bold, C.muted);
      y += labelH;
    }
    lines.forEach((l) => {
      if (lh(size) > room()) newPage();
      text(l, M, y, contentW, size, regular, color, align);
      y += lh(size);
    });
    y += s.sectionGap * 0.6;
  };
  if (model.remark) block(model.labels.remark, model.remark, s.fontSize, C.text);
  if (model.footer.terms) block(model.labels.terms, model.footer.terms, s.smallSize, C.muted);
  if (model.footer.thankYou) block(null, model.footer.thankYou, s.fontSize, C.text, 'center');
  if (model.footer.signatory) {
    const h = lh(s.fontSize) * 2 + 28;
    if (h > room()) newPage();
    const sigW = 200;
    text(model.footer.signatory, M + contentW - sigW, y, sigW, s.fontSize, bold, C.text, 'right');
    hline(M + contentW - s.signatureLineWidth, M + contentW, y + lh(s.fontSize) + 26, C.line);
    text(model.labels.signatoryCaption, M + contentW - sigW, y + lh(s.fontSize) + 29, sigW, s.smallSize, regular, C.muted, 'right');
    y += h;
  }

  /* ---- page footers, now that the page count is known ---- */
  pages.forEach((p, i) => {
    page = p;
    const top = H - M - s.smallSize * 1.2;
    hline(M, M + contentW, top - 4, C.line);
    text(`${model.title} ${model.documentLabel}`, M, top, contentW / 2, s.smallSize, regular, C.muted);
    text(`Page ${i + 1} of ${pages.length}`, M + contentW / 2, top, contentW / 2, s.smallSize, regular, C.muted, 'right');
  });

  tx.finish();
  return doc.save();
}
