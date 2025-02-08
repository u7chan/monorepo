/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      whitespace: {
        'pre-wrap': 'pre-wrap',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'), // react-markdown で利用
  ],
}
