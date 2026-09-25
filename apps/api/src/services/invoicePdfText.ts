import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray, PDFHexString, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFString,
  appendBezierCurve, beginText, closePath, concatTransformationMatrix, endText, fill, lineTo, moveTo, popGraphicsState, pushGraphicsState, setFillingRgbColor, setFontAndSize, setGraphicsState, setTextMatrix, setTextRise,
  type PDFDocument, type PDFPage, type PDFRef, type RGB,
} from 'pdf-lib';

/**
 * The invoice PDF's text engine (docs/INVOICE_TEMPLATES.md, "PDF text: scripts and shaping").
 *
 *   Unicode string ─> script runs ─> HarfBuzz shaping ─> positioned glyph runs ─> PDF glyphs
 *                     (font per run)  (WASM, per run)   (measured AND drawn)     + ToUnicode per cluster
 *
 * - **Script runs.** A string may mix scripts ("ClickG Studio - સુરત"). Gujarati letters go to Noto
 *   Sans Gujarati, Devanagari to Noto Sans Devanagari, and everything else — Latin, digits,
 *   spaces, punctuation, ₹ — to Noto Sans, so a figure looks the same in any script. Marks and
 *   joiners stay with the run before them; a danda stays with the Indic run it ends.
 * - **Shaping** is HarfBuzz (harfbuzzjs, WASM) — the same engine Chrome uses — so conjuncts, reph,
 *   the pre-base િ / ि and mark positions come out as a browser draws them. Every glyph's x/y
 *   advance and x/y offset is kept and written into the PDF.
 * - **One shaped result** serves measuring (column widths, wrapping, alignment, page fit) and
 *   drawing, so what was measured is exactly what is drawn.
 * - **Searchable text.** Each font is embedded as a CID font whose CIDs are allocated per
 *   (glyph, text, width). Each cluster's characters are dealt to its advancing glyphs in drawing
 *   order, marks on zero-width carrier glyphs (`placeCluster`), so copy, search and extraction
 *   return the original string in logical order even where a vowel sign is drawn before its
 *   consonant. Glyphs that carry no text are drawn as outlines. No hidden second text layer.
 * - **Nothing is ever drawn as a box.** A character no embedded font has is reported before
 *   drawing (`unprintableCharacters`), and a glyph 0 reaching the shaper is an error, never a blank.
 *
 * Process-level caches: the WASM module, font bytes and parsed fonts (read-only assets, no tenant
 * data). Everything with invoice text in it lives only as long as one render.
 */

/* ------------------------------------------------------------ assets -- */

export type Weight = 'regular' | 'bold';
type Script = 'latin' | 'gujarati' | 'devanagari';
type FontKey = `${Script}-${Weight}`;

const FAMILY: Record<Script, string> = { latin: 'NotoSans', gujarati: 'NotoSansGujarati', devanagari: 'NotoSansDevanagari' };
const HB_SCRIPT: Record<Script, string> = { latin: 'Latn', gujarati: 'Gujr', devanagari: 'Deva' };
const WEIGHT_FILE: Record<Weight, string> = { regular: 'Regular', bold: 'SemiBold' };
const fileOf = (key: FontKey) => {
  const [script, weight] = key.split('-') as [Script, Weight];
  return `${FAMILY[script]}-${WEIGHT_FILE[weight]}.ttf`;
};

const bytesCache = new Map<string, Uint8Array>();
/**
 * The fonts are pre-subset by `scripts/build-invoice-fonts.mjs` and committed in
 * `apps/api/assets/fonts/`. The bundle carries them in `dist/fonts/` (copied by build.mjs) next to
 * server.js; in dev and tests they are read from assets/. Resolved from this module's own URL,
 * never from the working directory.
 */
function fontBytes(file: string): Uint8Array {
  const cached = bytesCache.get(file);
  if (cached) return cached;
  const bundled = fileURLToPath(new URL(`./fonts/${file}`, import.meta.url));
  const path = existsSync(bundled) ? bundled : fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url));
  const bytes = new Uint8Array(readFileSync(path));
  bytesCache.set(file, bytes);
  return bytes;
}

const deflatedCache = new Map<string, Uint8Array>();
/** A font program as embedded (Flate-compressed) — compressed once per process, not per PDF. */
function deflatedFont(file: string): Uint8Array {
  let d = deflatedCache.get(file);
  if (!d) deflatedCache.set(file, (d = new Uint8Array(deflateSync(fontBytes(file)))));
  return d;
}

type FontkitFont = ReturnType<typeof fontkit.create>;
const metricsCache = new Map<FontKey, FontkitFont>();
/** fontkit's view of a font: character coverage, glyph advance widths and descriptor metrics. */
function metrics(key: FontKey): FontkitFont {
  let f = metricsCache.get(key);
  if (!f) metricsCache.set(key, (f = fontkit.create(Buffer.from(fontBytes(fileOf(key))))));
  return f;
}

/* ------------------------------------------------------------ script runs -- */

const isGujarati = (cp: number) => cp >= 0x0a80 && cp <= 0x0aff;
const isDevanagari = (cp: number) => (cp >= 0x0900 && cp <= 0x097f && cp !== 0x0964 && cp !== 0x0965) || (cp >= 0xa8e0 && cp <= 0xa8ff);
const isDanda = (cp: number) => cp === 0x0964 || cp === 0x0965;
/** Characters that belong to whatever run they follow: combining marks, ZWNJ/ZWJ, variation selectors. */
const isInherited = (cp: number) => (cp >= 0x0300 && cp <= 0x036f) || cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f);
/** Default-ignorable characters: HarfBuzz draws them as nothing, so no font needs a glyph for them. */
const isIgnorable = (cp: number) => (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff || (cp >= 0xfe00 && cp <= 0xfe0f);

interface Run { script: Script; start: number; end: number } // UTF-16 offsets into the string

export function scriptRuns(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const prev = runs.at(-1);
    let script: Script;
    if (isGujarati(cp)) script = 'gujarati';
    else if (isDevanagari(cp)) script = 'devanagari';
    else if (isDanda(cp)) script = prev && prev.script !== 'latin' ? prev.script : 'devanagari';
    else if (isInherited(cp)) script = prev?.script ?? 'latin';
    else script = 'latin';
    if (prev && prev.script === script) prev.end = i + ch.length;
    else runs.push({ script, start: i, end: i + ch.length });
    i += ch.length;
  }
  return runs;
}

/**
 * The characters of `text` that no embedded font can draw — they would print as boxes. Pure cmap
 * lookup (no WASM), so the preview can warn even if the shaper is unavailable.
 */
export function unprintableCharacters(text: string): string[] {
  const missing = new Set<string>();
  for (const run of scriptRuns(text)) {
    const font = metrics(`${run.script}-regular`); // both weights share one character set
    for (const ch of text.slice(run.start, run.end)) {
      const cp = ch.codePointAt(0)!;
      if (!isIgnorable(cp) && !font.hasGlyphForCodePoint(cp)) missing.add(ch);
    }
  }
  return [...missing];
}

/* ------------------------------------------------------------ HarfBuzz -- */

type HB = typeof import('harfbuzzjs');
let hbModule: Promise<HB> | null = null;
/**
 * harfbuzzjs instantiates its WASM when first imported. It is imported lazily, on the first PDF,
 * so a broken WASM can only fail a PDF request (a controlled error) — never the server's start.
 * The bundle resolves `harfbuzz.wasm` beside server.js (build.mjs copies it there).
 */
const harfbuzz = () => (hbModule ??= import('harfbuzzjs'));

interface ShaperFont { key: FontKey; upem: number; hb: InstanceType<HB['Font']>; fk: FontkitFont; /** The space glyph: drawn at zero width it shows nothing, so it can carry text. */ space: number }

export interface ShapedGlyph {
  gid: number;
  /** HarfBuzz position, in font units. */
  ax: number; ay: number; dx: number; dy: number;
  /**
   * The original characters this glyph stands for in copied text (see `placeText`). `null`: the
   * glyph carries no text and is drawn as an outline — a glyph beyond its cluster's character
   * count (ई is two glyphs, one character), or one whose text had to move to a carrier.
   */
  text: string | null;
}

const hasMn = (s: string) => /\p{Mn}/u.test(s);

/**
 * Decides which glyph of a HarfBuzz cluster carries which of its characters in copied text.
 *
 * The rule text extractors impose (pdf.js among them): a glyph whose text contains a nonspacing
 * mark (virama, most vowel signs, anusvara...) is taken as ZERO-WIDTH. Put such text on a glyph
 * that really advances and the extractor's position tracking drifts, inventing or dropping
 * spaces. So:
 *
 * - The cluster's text is cut into tokens — one mark-free character plus the marks after it.
 * - Each ADVANCING glyph, in drawing order, takes one token (the last one takes the rest). It
 *   keeps the token's mark-free part; the marks move to CARRIERS just after it in the content
 *   stream — the font's space glyph at zero width, which draws nothing. Stream order is text
 *   order, so the glyphs and carriers still spell the cluster exactly, even where a vowel sign is
 *   drawn before its consonant (પ્રિ, कि).
 * - Zero-advance glyphs (vowel signs above/below, anusvara, reph) carry no text: they are drawn as
 *   outlines at their HarfBuzz position, so they cannot disturb anything.
 * - A cluster with more advancing glyphs than tokens (rare) is drawn wholly as outlines, and its
 *   text rides on carriers that span the cluster's advance.
 *
 * Glyphs come in with `text: null`; carriers are new glyphs. Nothing here moves a drawn glyph.
 */
function placeCluster(gs: ShapedGlyph[], text: string, space: number): ShapedGlyph[] {
  const carrier = (t: string, ax = 0): ShapedGlyph => ({ gid: space, ax, ay: 0, dx: 0, dy: 0, text: t });
  const tokens: string[] = [];
  for (const ch of text) {
    if (tokens.length && hasMn(ch)) tokens[tokens.length - 1] += ch;
    else tokens.push(ch);
  }
  // Marks before the first letter (a stray sign) travel with it.
  if (tokens.length > 1 && !/\P{Mn}/u.test(tokens[0])) tokens.splice(0, 2, tokens[0] + tokens[1]);
  const advancing = gs.filter((g) => g.ax > 0).length;
  if (advancing > 0 && advancing <= tokens.length) {
    let i = 0;
    return gs.flatMap((g) => {
      if (g.ax <= 0) return [g];
      const t = i === advancing - 1 ? tokens.slice(i).join('') : tokens[i];
      i++;
      const parts = t.match(/\p{Mn}+|\P{Mn}+/gu)!;
      const k = parts.findIndex((p) => !hasMn(p));
      if (k < 0) return [carrier(t), g];
      const before = parts.slice(0, k).join('');
      const after = parts.slice(k + 1).join('');
      return [...(before ? [carrier(before)] : []), { ...g, text: parts[k] }, ...(after ? [carrier(after)] : [])];
    });
  }
  // Outlines only: each keeps its place relative to the cluster's start (the pen stays there),
  // then the carriers advance the pen by the cluster's width, shared by the mark-free parts.
  let pen = 0;
  const outlines = gs.map((g) => {
    const o = { ...g, ax: 0, dx: pen + g.dx };
    pen += g.ax;
    return o;
  });
  const parts = text.match(/\p{Mn}+|\P{Mn}+/gu) ?? [];
  const letters = parts.filter((p) => !hasMn(p)).length;
  if (!letters) return [...outlines, ...parts.map((p) => carrier(p)), { gid: space, ax: pen, ay: 0, dx: 0, dy: 0, text: null }];
  return [...outlines, ...parts.map((p) => carrier(p, hasMn(p) ? 0 : pen / letters))];
}
export interface ShapedRun { font: ShaperFont; glyphs: ShapedGlyph[]; advance: number }
export interface ShapedText {
  text: string;
  runs: ShapedRun[];
  /** UTF-16 offsets where a line may be broken without splitting a cluster (conjunct, syllable, base + marks). */
  clusterStarts: Set<number>;
  /** Width in points at `size`, from the shaped advances. */
  width(size: number): number;
}

export class UnprintableTextError extends Error {
  constructor(public characters: string[]) {
    super('Text contains characters no invoice font can draw');
  }
}

/** Process-level shaper: one WASM module, one HarfBuzz font per (script, weight), one reusable buffer. */
class Shaper {
  private fonts = new Map<FontKey, ShaperFont>();
  private buffer: InstanceType<HB['Buffer']>;
  private noLigatures: InstanceType<HB['Feature']>[];

  constructor(private hb: HB) {
    this.buffer = new hb.Buffer();
    // Latin only: ligatures off, so "fi" stays two plain letters as it always printed.
    this.noLigatures = [new hb.Feature('liga', 0), new hb.Feature('clig', 0)];
  }

  font(key: FontKey): ShaperFont {
    let f = this.fonts.get(key);
    if (!f) {
      const face = new this.hb.Face(new this.hb.Blob(fontBytes(fileOf(key))));
      f = { key, upem: face.upem, hb: new this.hb.Font(face), fk: metrics(key), space: metrics(key).glyphForCodePoint(0x20).id };
      this.fonts.set(key, f);
    }
    return f;
  }

  shape(text: string, weight: Weight): ShapedText {
    const runs: ShapedRun[] = [];
    const clusterStarts = new Set<number>([0, text.length]);
    for (const run of scriptRuns(text)) {
      const font = this.font(`${run.script}-${weight}`);
      const buf = this.buffer;
      buf.reset();
      // The whole string goes in as context; only [start, end) is shaped. Clusters are UTF-16 offsets into `text`.
      buf.addText(text, run.start, run.end - run.start);
      buf.setDirection(this.hb.Direction.LTR);
      buf.setScript(HB_SCRIPT[run.script]);
      this.hb.shape(font.hb, buf, run.script === 'latin' ? this.noLigatures : undefined);
      const out = buf.getGlyphInfosAndPositions();

      // Cluster values are monotone for LTR text (the default cluster level), so the text of a
      // cluster runs from its value to the next distinct value — or the run's end.
      const starts = [...new Set(out.map((g) => g.cluster))].sort((a, b) => a - b);
      const endOf = new Map(starts.map((c, i) => [c, starts[i + 1] ?? run.end]));
      const missing: string[] = [];
      const glyphs: ShapedGlyph[] = [];
      for (let i = 0; i < out.length; ) {
        const cluster = out[i].cluster;
        const members: ShapedGlyph[] = [];
        for (; i < out.length && out[i].cluster === cluster; i++) {
          const g = out[i];
          members.push({ gid: g.codepoint, ax: g.xAdvance ?? 0, ay: g.yAdvance ?? 0, dx: g.xOffset ?? 0, dy: g.yOffset ?? 0, text: null });
        }
        const clusterText = text.slice(cluster, endOf.get(cluster));
        clusterStarts.add(cluster);
        if (members.some((g) => g.gid === 0)) missing.push(...[...clusterText].filter((ch) => !isIgnorable(ch.codePointAt(0)!) && !font.fk.hasGlyphForCodePoint(ch.codePointAt(0)!)));
        glyphs.push(...placeCluster(members, clusterText, font.space));
      }
      if (missing.length) throw new UnprintableTextError([...new Set(missing)]);
      if (out.some((g) => g.codepoint === 0)) {
        const runText = text.slice(run.start, run.end);
        const chars = unprintableCharacters(runText);
        throw new UnprintableTextError(chars.length ? chars : [runText]);
      }
      runs.push({ font, glyphs, advance: glyphs.reduce((t, g) => t + g.ax, 0) });
    }
    return { text, runs, clusterStarts, width: (size) => runs.reduce((t, r) => t + (r.advance * size) / r.font.upem, 0) };
  }
}

let shaperPromise: Promise<Shaper> | null = null;
// A failure is not memoised here, so a later PDF tries again (the bundled module may still hold
// its own rejection — a restart is the real recovery once the WASM is back).
const shaper = () =>
  (shaperPromise ??= harfbuzz().then(
    (hb) => new Shaper(hb),
    (e) => {
      shaperPromise = null;
      hbModule = null;
      throw e;
    },
  ));

/* -------------------------------------------------------- PDF text writer -- */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
/** UTF-16BE hex, as a ToUnicode CMap wants it (JS strings already are UTF-16, surrogates included). */
const utf16Hex = (s: string) => Array.from({ length: s.length }, (_, i) => hex4(s.charCodeAt(i))).join('');
const round = (n: number) => Math.round(n * 1000) / 1000;

interface EmbeddedFont { ref: PDFRef; font: ShaperFont; cids: Map<string, number>; entries: { gid: number; text: string; width: number }[] }

export interface DrawOptions { opacity?: number; /** Degrees, counter-clockwise, about (x, y). */ rotate?: number }

/**
 * One document's text: measures (memoised per render) and draws shaped text, then writes the
 * fonts it used. Call `finish()` once, after the last draw and before `doc.save()`.
 */
export class PdfText {
  private measured = new Map<string, ShapedText>();
  private embedded = new Map<FontKey, EmbeddedFont>();
  private fontKeys = new WeakMap<PDFPage, Map<FontKey, PDFName>>();
  private gsKeys = new WeakMap<PDFPage, Map<number, PDFName>>();

  private constructor(private doc: PDFDocument, private shaper: Shaper) {}

  static async create(doc: PDFDocument) {
    return new PdfText(doc, await shaper());
  }

  shape(text: string, weight: Weight): ShapedText {
    const k = `${weight}\u0000${text}`;
    let s = this.measured.get(k);
    if (!s) this.measured.set(k, (s = this.shaper.shape(text, weight)));
    return s;
  }

  width(text: string, size: number, weight: Weight) {
    return this.shape(text, weight).width(size);
  }

  /**
   * Word-wraps one paragraph (no line breaks in it) to `maxW`. Breaks between words; a single word
   * wider than the line is broken only where it is safe — a grapheme boundary that is also a
   * HarfBuzz cluster boundary, so no conjunct, syllable or base + mark is ever split.
   */
  wrapParagraph(para: string, size: number, weight: Weight, maxW: number): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of para.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.width(candidate, size, weight) <= maxW) { line = candidate; continue; }
      if (line) out.push(line);
      if (this.width(word, size, weight) <= maxW) { line = word; continue; }
      const pieces = this.breakWord(word, size, weight, maxW);
      out.push(...pieces.slice(0, -1));
      line = pieces.at(-1)!;
    }
    out.push(line);
    return out;
  }

  private breakWord(word: string, size: number, weight: Weight, maxW: number): string[] {
    const clusters = this.shape(word, weight).clusterStarts;
    const safe = [...graphemes.segment(word)].map((s) => s.index).filter((i) => i > 0 && clusters.has(i));
    safe.push(word.length);
    const pieces: string[] = [];
    let from = 0;
    while (from < word.length) {
      const candidates = safe.filter((b) => b > from);
      // The longest piece that fits; at least one safe unit even if that alone is too wide.
      let cut = candidates[0];
      for (const b of candidates) {
        if (this.width(word.slice(from, b), size, weight) <= maxW) cut = b;
        else break;
      }
      pieces.push(word.slice(from, cut));
      from = cut;
    }
    return pieces;
  }

  /** Draws shaped text with its baseline origin at (x, y), PDF coordinates. */
  draw(page: PDFPage, text: string, x: number, y: number, size: number, weight: Weight, color: RGB, opts: DrawOptions = {}) {
    const shaped = this.shape(text, weight);
    if (!shaped.runs.length) return;
    const a = ((opts.rotate ?? 0) * Math.PI) / 180;
    const line = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, y].map(round) as [number, number, number, number, number, number];
    const ops: PDFOperator[] = [pushGraphicsState()];
    if (opts.opacity !== undefined) ops.push(setGraphicsState(this.gsKey(page, opts.opacity)));
    ops.push(setFillingRgbColor(color.red, color.green, color.blue), beginText(), setTextMatrix(...line));
    // Every glyph lands exactly where HarfBuzz put it. A glyph's CID carries the width from its
    // x offset to the next pen position (advance - offset), so a TJ number before the glyph moves
    // to its offset and the glyph itself lands the pen on HarfBuzz's advance — the pen never jumps
    // forward (a gap a text extractor would read as a space). A y offset (a mark above or below)
    // is a text rise. All runs share one text object: no gap or jump between scripts.
    const outlines: { font: ShaperFont; gid: number; x: number; y: number }[] = [];
    let penX = 0; // points, along the line
    let penY = 0;
    let rise = 0;
    for (const run of shaped.runs) {
      const font = this.embed(run.font);
      const k = 1000 / run.font.upem; // font units -> TJ thousandths of the font size
      const pt = size / run.font.upem; // font units -> points
      ops.push(setFontAndSize(this.fontKey(page, run.font), size));
      let items: (PDFHexString | PDFNumber)[] = [];
      let adjust = 0; // TJ units still to apply; positive moves LEFT
      const pushAdjust = () => {
        if (Math.abs(adjust) > 1e-6) items.push(PDFNumber.of(round(adjust)));
        adjust = 0;
      };
      const show = () => {
        pushAdjust();
        if (!items.length) return;
        const arr = PDFArray.withContext(this.doc.context);
        items.forEach((it) => arr.push(it));
        ops.push(PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [arr]));
        items = [];
      };
      for (const g of run.glyphs) {
        if (g.text === null) {
          // A surplus glyph of its cluster: drawn as an outline after the text, not as text.
          outlines.push({ font: run.font, gid: g.gid, x: penX + g.dx * pt, y: (penY + g.dy) * pt });
          adjust -= g.ax * k;
        } else {
          const wantRise = round((penY + g.dy) * pt);
          if (wantRise !== rise) {
            show();
            ops.push(setTextRise(wantRise));
            rise = wantRise;
          }
          // Mark text is zero-width to extractors, so its CID is zero-width too and TJ numbers do
          // the moving; otherwise the CID spans offset -> advance.
          const width = hasMn(g.text) ? 0 : Math.max(0, g.ax - g.dx);
          adjust -= g.dx * k;
          pushAdjust();
          items.push(PDFHexString.of(hex4(this.cid(font, g.gid, g.text, width))));
          adjust -= (g.ax - g.dx - width) * k;
        }
        penX += g.ax * pt;
        penY += g.ay;
      }
      show();
    }
    ops.push(endText());
    for (const o of outlines) {
      const path = outlineOps(o.font.fk.getGlyph(o.gid));
      if (!path.length) continue; // a hidden joiner or spacer: nothing to draw, and `f` needs a path
      ops.push(pushGraphicsState(), concatTransformationMatrix(...line), concatTransformationMatrix(size / o.font.upem, 0, 0, size / o.font.upem, round(o.x), round(o.y)));
      ops.push(...path, fill(), popGraphicsState());
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }

  /** Writes the embedded fonts. Only the fonts a document actually used are embedded. */
  finish() {
    const ctx = this.doc.context;
    for (const e of this.embedded.values()) {
      const f = e.font.fk;
      const bytes = fontBytes(fileOf(e.font.key));
      const scale = 1000 / f.unitsPerEm;
      const name = psName(e.font);
      const fontFile = ctx.register(ctx.stream(deflatedFont(fileOf(e.font.key)), { Filter: 'FlateDecode', Length1: bytes.length }));
      const descriptor = ctx.register(ctx.obj({
        Type: 'FontDescriptor',
        FontName: name,
        Flags: 4,
        FontBBox: [f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY].map((v) => Math.round(v * scale)),
        ItalicAngle: 0,
        Ascent: Math.round(f.ascent * scale),
        Descent: Math.round(f.descent * scale),
        CapHeight: Math.round((f.capHeight || f.ascent) * scale),
        StemV: 80,
        FontFile2: fontFile,
      }));
      // CID n (from 1) -> its glyph; CID 0 stays .notdef.
      const map = new Uint8Array((e.entries.length + 1) * 2);
      e.entries.forEach((en, i) => { map[(i + 1) * 2] = en.gid >> 8; map[(i + 1) * 2 + 1] = en.gid & 0xff; });
      const cidToGid = ctx.register(ctx.flateStream(map));
      const widths = e.entries.map((en) => round(en.width * scale));
      const cidFont = ctx.register(ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: name,
        CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: descriptor,
        DW: 0,
        W: [1, widths],
        CIDToGIDMap: cidToGid,
      }));
      const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap(e.entries.map((en) => en.text))));
      ctx.assign(e.ref, ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H', DescendantFonts: [cidFont], ToUnicode: toUnicode }));
    }
  }

  private embed(font: ShaperFont): EmbeddedFont {
    let e = this.embedded.get(font.key);
    if (!e) this.embedded.set(font.key, (e = { ref: this.doc.context.nextRef(), font, cids: new Map(), entries: [] }));
    return e;
  }

  /** One CID per (glyph, its text, its width): the same glyph can stand for different text, or sit at a different offset. */
  private cid(e: EmbeddedFont, gid: number, text: string, width: number): number {
    const k = `${gid}\u0000${width}\u0000${text}`;
    let cid = e.cids.get(k);
    if (cid === undefined) {
      if (e.entries.length >= 0xfffe) throw new Error('Too many distinct glyphs for one PDF font');
      e.entries.push({ gid, text, width });
      e.cids.set(k, (cid = e.entries.length));
    }
    return cid;
  }

  private fontKey(page: PDFPage, font: ShaperFont): PDFName {
    let m = this.fontKeys.get(page);
    if (!m) this.fontKeys.set(page, (m = new Map()));
    let name = m.get(font.key);
    if (!name) m.set(font.key, (name = page.node.newFontDictionary(psName(font), this.embed(font).ref)));
    return name;
  }

  private gsKey(page: PDFPage, opacity: number): PDFName {
    let m = this.gsKeys.get(page);
    if (!m) this.gsKeys.set(page, (m = new Map()));
    let name = m.get(opacity);
    if (!name) m.set(opacity, (name = page.node.newExtGState('GS', this.doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }))));
    return name;
  }
}

const psName = (font: ShaperFont) => font.fk.postscriptName ?? fileOf(font.key).replace(/\.ttf$/, '');

/** A glyph's outline as PDF path operators, in font units (quadratic curves raised to cubic). */
function outlineOps(glyph: ReturnType<FontkitFont['getGlyph']>): PDFOperator[] {
  const ops: PDFOperator[] = [];
  let cx = 0;
  let cy = 0;
  for (const { command, args } of (glyph.path as unknown as { commands: { command: string; args: number[] }[] }).commands) {
    if (command === 'moveTo') ops.push(moveTo(args[0], args[1]));
    else if (command === 'lineTo') ops.push(lineTo(args[0], args[1]));
    else if (command === 'quadraticCurveTo') {
      const [qx, qy, x, y] = args;
      ops.push(appendBezierCurve(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y));
    } else if (command === 'bezierCurveTo') ops.push(appendBezierCurve(args[0], args[1], args[2], args[3], args[4], args[5]));
    else if (command === 'closePath') ops.push(closePath());
    if (args.length >= 2) [cx, cy] = args.slice(-2);
  }
  return ops;
}

/** ToUnicode CMap: CID n -> the text of entry n-1. */
function toUnicodeCMap(texts: string[]): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const chunk = texts.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    chunk.forEach((t, j) => lines.push(`<${hex4(i + j + 1)}> <${utf16Hex(t)}>`));
    lines.push('endbfchar');
  }
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...lines,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  return new TextEncoder().encode(cmap);
}
