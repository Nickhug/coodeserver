import type { Config } from 'tailwindcss'
import { fontFamily } from "tailwindcss/defaultTheme"

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", ...fontFamily.sans],
        mono: ["var(--font-mono)", ...fontFamily.mono],
        inter: ["var(--font-inter)", ...fontFamily.sans],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        first: {
          "0%": { transform: "translate(-10%, -10%) scale(1)" },
          "25%": { transform: "translate(15%, 10%) scale(1.2)" },
          "50%": { transform: "translate(20%, -20%) scale(0.8)" },
          "75%": { transform: "translate(-15%, 15%) scale(1.1)" },
          "100%": { transform: "translate(-10%, -10%) scale(1)" },
        },
        second: {
          "0%": { transform: "translate(10%, 20%) rotate(0deg) scale(1)" },
          "33%": { transform: "translate(-20%, 10%) rotate(-10deg) scale(1.3)" },
          "66%": { transform: "translate(10%, -10%) rotate(10deg) scale(0.8)" },
          "100%": { transform: "translate(10%, 20%) rotate(0deg) scale(1)" },
        },
        third: {
          "0%": { transform: "translate(5%, -15%) scale(1)" },
          "20%": { transform: "translate(-25%, 10%) scale(1.2)" },
          "40%": { transform: "translate(15%, 5%) scale(0.9)" },
          "60%": { transform: "translate(-10%, -20%) scale(1.1)" },
          "80%": { transform: "translate(20%, 15%) scale(0.8)" },
          "100%": { transform: "translate(5%, -15%) scale(1)" },
        },
        fourth: {
          "0%": { transform: "translate(-20%, -10%) scale(1)" },
          "20%": { transform: "translate(10%, 20%) scale(1.15)" },
          "40%": { transform: "translate(-10%, 15%) scale(1.25)" },
          "60%": { transform: "translate(15%, -15%) scale(0.85)" },
          "80%": { transform: "translate(-15%, -20%) scale(0.95)" },
          "100%": { transform: "translate(-20%, -10%) scale(1)" },
        },
        fifth: {
          "0%": { transform: "translate(10%, 10%) scale(1)" },
          "25%": { transform: "translate(-15%, -10%) scale(1.2)" },
          "50%": { transform: "translate(20%, 20%) scale(0.8)" },
          "75%": { transform: "translate(15%, -20%) scale(1.1)" },
          "100%": { transform: "translate(10%, 10%) scale(1)" },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slow-float': {
          '0%': { transform: 'translateY(0) rotate3d(1, 1, 1, 0deg)' },
          '50%': { transform: 'translateY(-10px) rotate3d(1, 1, 1, 5deg)' },
          '100%': { transform: 'translateY(0) rotate3d(1, 1, 1, 0deg)' },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        blink: "blink 1s linear infinite",
        first: "first 13s ease-in-out infinite",
        second: "second 18s ease-in-out infinite",
        third: "third 15s ease-in-out infinite",
        fourth: "fourth 12s ease-in-out infinite",
        fifth: "fifth 10s ease-in-out infinite",
        'fade-in': 'fade-in 1s ease-in-out forwards',
        'slow-float': 'slow-float 4s ease-in-out infinite alternate',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic':
          'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
    },
  },
  plugins: [],
}
export default config 