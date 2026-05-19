import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#172026",
        paper: "#f8faf8",
        moss: "#34604b",
        coral: "#d96c4a"
      },
      boxShadow: {
        soft: "0 18px 70px rgba(23, 32, 38, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
