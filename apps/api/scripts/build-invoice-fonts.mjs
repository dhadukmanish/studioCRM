// Regenerates the invoice PDF fonts in apps/api/assets/fonts/ (committed). Run it only when the
// character coverage below has to change:
//
//   pnpm --filter @erp/api fonts:invoice
//
// Why pre-subset here instead of letting pdf-lib subset at render time: @pdf-lib/fontkit's
// subsetter drops glyph outlines for Noto Sans — the PDF's text layer is right but most letters
// render blank (found by looking at a real invoice, see docs/INVOICE_TEMPLATES.md). So each font is
// subset ONCE, here, with HarfBuzz (subset-font), and the renderer embeds the small result whole.
// HarfBuzz's subsetter keeps the layout closure (GSUB/GPOS), so every conjunct, half form, reph
// and mark position of the kept characters survives — the renderer shapes with HarfBuzz too.
//
// Three families, one per script, each in a regular and a semibold weight:
//   Noto Sans             Latin text, digits, punctuation and ₹ — everything that is not Indic
//   Noto Sans Gujarati    the Gujarati block
//   Noto Sans Devanagari  the Devanagari block (+ Devanagari Extended)
// The Indic subsets also keep the joiners (ZWJ/ZWNJ), the dotted circle HarfBuzz inserts for a
// stray mark, the space glyph HarfBuzz uses for invisible characters, and the dandas. Latin, digits
// and ₹ inside Indic text are drawn by Noto Sans, so money looks the same whatever the script.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const require = createRequire(import.meta.url);
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');

const text = (ranges) => {
  let s = '';
  for (const [from, to] of ranges) for (let c = from; c <= to; c++) s += String.fromCodePoint(c);
  return s;
};

const LATIN = text([
  [0x0020, 0x007e], // Basic Latin
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x017f], // Latin Extended-A
  [0x2010, 0x2027], // dashes, quotes, bullet, ellipsis
  [0x2030, 0x203a], // per mille, primes, angle quotes
  [0x20ac, 0x20ac], // €
  [0x20b9, 0x20b9], // ₹
  [0x2116, 0x2116], // №
  [0x2122, 0x2122], // ™
]);
// Shared by both Indic subsets: space and no-break space, the dandas, ZWNJ / ZWJ, dotted circle.
const INDIC_COMMON = text([[0x0020, 0x0020], [0x00a0, 0x00a0], [0x0964, 0x0965], [0x200c, 0x200d], [0x25cc, 0x25cc]]);
const GUJARATI = text([[0x0a80, 0x0aff]]) + INDIC_COMMON;
const DEVANAGARI = text([[0x0900, 0x097f], [0xa8e0, 0xa8ff]]) + INDIC_COMMON;

const FAMILIES = [
  { pkg: '@expo-google-fonts/noto-sans', src: 'NotoSans', out: 'NotoSans', chars: LATIN, license: 'OFL.txt' },
  { pkg: '@expo-google-fonts/noto-sans-gujarati', src: 'NotoSansGujarati', out: 'NotoSansGujarati', chars: GUJARATI, license: 'OFL-Gujarati.txt' },
  { pkg: '@expo-google-fonts/noto-sans-devanagari', src: 'NotoSansDevanagari', out: 'NotoSansDevanagari', chars: DEVANAGARI, license: 'OFL-Devanagari.txt' },
];
const WEIGHTS = [
  ['400Regular', 'Regular'],
  ['600SemiBold', 'SemiBold'],
];

await mkdir(outDir, { recursive: true });
for (const f of FAMILIES) {
  for (const [dir, weight] of WEIGHTS) {
    const source = await readFile(require.resolve(`${f.pkg}/${dir}/${f.src}_${dir}.ttf`));
    const subset = await subsetFont(source, f.chars, { targetFormat: 'truetype' });
    const to = `${f.out}-${weight}.ttf`;
    await writeFile(path.join(outDir, to), subset);
    console.log(`${to}: ${subset.length} bytes`);
  }
  await copyFile(path.join(path.dirname(require.resolve(`${f.pkg}/package.json`)), 'LICENSE_FONT'), path.join(outDir, f.license));
  console.log(`${f.license} copied`);
}
