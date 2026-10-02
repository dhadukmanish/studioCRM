/** @type {import('tailwindcss').Config} */
// Every color resolves to a CSS variable defined in src/themes.css, so switching
// data-theme (light | dark | olive) re-skins the whole app without touching components.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (prefix, steps) => Object.fromEntries(steps.map((s) => [s, v(`${prefix}-${s}`)]));

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: v('primary'), dark: v('primary-dark'), lighter: v('primary-lighter'), 50: v('primary-50'), 100: v('primary-lighter'), 600: v('primary'), 700: v('primary-dark') },
        gray: scale('gray', [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]),
        white: v('surface'),
        surface: v('surface'),
        sidebar: v('sidebar'),
        field: v('input-bg'), // .input fill
        muted: v('gray-200'),
        line: v('line'),
        page: v('page'),
        series: { 1: v('series-1'), 2: v('series-2'), 3: v('series-3'), 4: v('series-4'), 5: v('series-5') }, // figure marks only (themes.css)
        head: v('head'), // table header background
        input: v('input-border'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['"Lexend Deca"', 'Inter', 'sans-serif'],
      },
      fontSize: { xxs: ['11px', '14px'] },
      boxShadow: { card: '0 1px 2px 0 rgb(var(--shadow) / 0.06)', btn: '0 1px 2px 0 rgb(var(--primary) / 0.25)' },
      borderRadius: { DEFAULT: 'var(--r-default)', sm: 'var(--r-sm)', md: 'var(--r-md)', lg: 'var(--r-lg)' }, // themes.css :root
    },
  },
  plugins: [],
};
