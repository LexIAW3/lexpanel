/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af',
        },
        ink: '#0a0a0a',
      },
      fontFamily: {
        display: ['Bebas Neue', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 8px 28px rgba(10, 10, 10, 0.08)',
      },
    },
  },
  plugins: [],
};
