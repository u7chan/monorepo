import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      whitespace: {
        'pre-wrap': 'pre-wrap',
      },
    },
  },
  plugins: [
    typography, // react-markdown で利用
  ],
}
