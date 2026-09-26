// ---------------------------------------------------------------------------
// Theme registry + apply helper. Add a theme: define its tokens in themes.css
// under [data-theme='<key>'] and add it to THEMES.
// ---------------------------------------------------------------------------
export type ThemeKey = 'light' | 'dark' | 'olive' | 'sky' | 'slate' | 'teal' | 'lavender';
export type ThemePref = ThemeKey | 'system';

export const THEMES: { key: ThemeKey; label: string; swatch: string; description: string }[] = [
  { key: 'light', label: 'Light', swatch: '#006CB8', description: 'Clean blue on white' },
  { key: 'dark', label: 'Dark', swatch: '#181B21', description: 'Low-light friendly' },
  { key: 'olive', label: 'Olive', swatch: '#607A1E', description: 'Warm, earthy tones' },
  { key: 'sky', label: 'Sky', swatch: '#0370AC', description: 'Light sky-blue on blue-gray' },
  { key: 'slate', label: 'Slate', swatch: '#3D4C61', description: 'Cool neutral slate' },
  { key: 'teal', label: 'Teal', swatch: '#0F766E', description: 'Muted teal on white' },
  { key: 'lavender', label: 'Soft Lavender', swatch: '#67589C', description: 'Subtle muted lavender' },
];

export function resolveTheme(pref: ThemePref): ThemeKey {
  if (pref !== 'system') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref) {
  const key = resolveTheme(pref);
  document.documentElement.dataset.theme = key;
  document.documentElement.style.colorScheme = key === 'dark' ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES.find((t) => t.key === key)?.swatch ?? '#ffffff');
}
