/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#006CB8', dark: '#005A99', lighter: '#CCE2F2', 50: '#EAF3FA', 100: '#CCE2F2', 600: '#006CB8', 700: '#005A99' },
        gray: { 0: '#FFFFFF', 50: '#FAFAFA', 100: '#F1F1F1', 200: '#E3E3E3', 300: '#DFDFDF', 400: '#929292', 500: '#666666', 600: '#484848', 700: '#333333', 800: '#222222', 900: '#111111', 1000: '#000000' },
        muted: '#E3E3E3',
        line: '#E2E8F0',
        page: '#F8FAFC',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['"Lexend Deca"', 'Inter', 'sans-serif'],
      },
      fontSize: { xxs: ['11px', '14px'] },
      boxShadow: { card: '0 1px 2px 0 rgba(0,0,0,0.05)', btn: '0 1px 2px 0 rgba(0,108,184,0.2)' },
      borderRadius: { DEFAULT: '8px' },
    },
  },
  plugins: [],
};
