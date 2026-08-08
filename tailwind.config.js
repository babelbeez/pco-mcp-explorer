/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.ts'],
  theme: {
    extend: {
      colors: {
        'brand-primary': '#0d9488',
        'brand-primary-dark': '#0f766e',
        'brand-heading': '#1f2937',
        'brand-body': '#4b5563',
        'brand-background-light': '#f9fafb',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
