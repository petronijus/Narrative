/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Narrative brand palette — extended in M20 (themes)
        surface: {
          DEFAULT: '#1a1a2e',
          raised: '#16213e',
          overlay: '#0f3460',
        },
      },
    },
  },
  plugins: [],
}
