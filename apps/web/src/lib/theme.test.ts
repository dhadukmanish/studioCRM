import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES } from './theme';

/**
 * Every theme the switcher offers must be a complete token set in themes.css — a missing block or
 * token would silently fall back to Light's value and mix two themes on one screen.
 */
const css = readFileSync(fileURLToPath(new URL('../themes.css', import.meta.url)), 'utf8');
const TOKENS = ['--primary', '--primary-dark', '--primary-lighter', '--primary-50', '--surface', '--page', '--head', '--line', '--input-border', '--gray-500', '--gray-900'];
const block = (key: string) => {
  const start = css.indexOf(key === 'light' ? ":root, [data-theme='light'] {" : `[data-theme='${key}'] {`);
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
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
    expect(THEMES.map((t) => t.key)).toEqual(['light', 'dark', 'olive', 'sky', 'slate', 'teal', 'lavender']);
  });

  it.each(THEMES.map((t) => t.key))('%s defines every token', (key) => {
    const b = block(key);
    expect(b).not.toBe('');
    for (const t of TOKENS) expect(b, `${key} ${t}`).toContain(`${t}:`);
  });

  it.each(THEMES.filter((t) => t.key !== 'dark').map((t) => t.key))('%s: white button text on --primary meets 4.5:1', (key) => {
    const primary = token(block(key), '--primary');
    // A missing token must fail here, not read as black (which would "pass" at 21:1).
    expect(primary).toMatch(/^\d+ \d+ \d+$/);
    const ratio = (1 + 0.05) / (luminance(primary) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
