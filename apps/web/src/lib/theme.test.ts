import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DARK_THEMES, THEMES } from './theme';

/**
 * Every theme the switcher offers must be a complete token set in themes.css — a missing block or
 * token would silently fall back to Light's value and mix two themes on one screen.
 */
const css = readFileSync(fileURLToPath(new URL('../themes.css', import.meta.url)), 'utf8');
const TOKENS = ['--primary', '--primary-dark', '--primary-lighter', '--primary-50', '--surface', '--page', '--head', '--line', '--input-border', '--gray-500', '--gray-900'];
/** A theme's own block: its selector may head a list (`[data-theme='x'], [data-theme='x'] .card {`). */
const block = (key: string) => {
  const head = key === 'light' ? ":root, [data-theme='light']" : `[data-theme='${key}']`;
  const m = [`${head} {`, `${head}, `].map((h) => css.indexOf(h)).filter((i) => i >= 0);
  return m.length ? css.slice(Math.min(...m), css.indexOf('}', Math.min(...m))) : '';
};
/** Contrast ratio of two "r g b" token values. */
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** WCAG relative luminance of an "r g b" token value. */
const luminance = (rgb: string) => {
  const [r, g, b] = rgb.trim().split(/\s+/).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const token = (b: string, name: string) => b.match(new RegExp(`${name}:\\s*([0-9]+ [0-9]+ [0-9]+);`))?.[1] ?? '';

describe('themes', () => {
  it('keeps Light, Dark and Olive and adds the professional set', () => {
    expect(THEMES.map((t) => t.key)).toEqual(['light', 'dark', 'olive', 'sky', 'slate', 'teal', 'lavender', 'mist', 'olivepro', 'tealmint', 'dusk']);
  });

  it.each(THEMES.map((t) => t.key))('%s defines every token', (key) => {
    const b = block(key);
    expect(b).not.toBe('');
    for (const t of TOKENS) expect(b, `${key} ${t}`).toContain(`${t}:`);
  });

  it.each(THEMES.filter((t) => !DARK_THEMES.includes(t.key)).map((t) => t.key))('%s: white button text on --primary meets 4.5:1', (key) => {
    const primary = token(block(key), '--primary');
    // A missing token must fail here, not read as black (which would "pass" at 21:1).
    expect(primary).toMatch(/^\d+ \d+ \d+$/);
    const ratio = (1 + 0.05) / (luminance(primary) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  // On a dark theme the primary button's text is the surface colour (text-white maps to --surface).
  it.each([...DARK_THEMES])('%s: surface-coloured button text on --primary meets 4.5:1', (key) => {
    const b = block(key);
    const [p, s] = [luminance(token(b, '--primary')), luminance(token(b, '--surface'))];
    expect((Math.max(p, s) + 0.05) / (Math.min(p, s) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES.map((t) => t.key))('%s: body text (gray-900) on the surface meets 7:1', (key) => {
    const b = block(key);
    const [t, s] = [luminance(token(b, '--gray-900')), luminance(token(b, '--surface'))];
    expect((Math.max(t, s) + 0.05) / (Math.min(t, s) + 0.05)).toBeGreaterThanOrEqual(7);
  });

  // Every light theme draws its sidebar and header as a dark bar (.app-chrome); dark themes are left out
  // by a :not() list that must match DARK_THEMES, or a dark theme would get a light theme's bar.
  const BAR = `:root${DARK_THEMES.map((k) => `:not([data-theme='${k}'])`).join('')}`;
  it('the dark bar applies to exactly the light themes', () => {
    expect(css).toContain(`${BAR} {`);
    expect(css).toContain(`${BAR} .app-chrome {`);
    expect(css).toContain(`${BAR} .app-chrome .card {`);
  });

  it.each(THEMES.filter((t) => !DARK_THEMES.includes(t.key)).map((t) => t.key))('%s: sidebar and header read clearly on the dark bar', (key) => {
    const b = block(key);
    const start = css.indexOf(`${BAR} .app-chrome {`);
    const bar = css.slice(start, css.indexOf('}', start));
    const [c1, c2, c3, accent] = ['--chrome', '--chrome-2', '--chrome-3', '--chrome-accent'].map((t) => token(b, t));
    for (const v of [c1, c2, c3, accent]) expect(v, key).toMatch(/^\d+ \d+ \d+$/);
    expect(contrast(token(bar, '--gray-600'), c1), 'menu text').toBeGreaterThanOrEqual(7);
    expect(contrast(token(bar, '--gray-400'), c1), 'section labels').toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, c3), 'selected item').toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, c2), 'brand initials on the accent').toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(bar, '--gray-800'), c2), 'search text').toBeGreaterThanOrEqual(7);
  });
});
