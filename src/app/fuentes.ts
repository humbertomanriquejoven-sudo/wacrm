import localFont from "next/font/local";

// Inter y JetBrains Mono autogestionadas a partir de woff2 locales (SIL Open
// Font License). Con CSS variables para usarlas desde globals.css.
export const inter = localFont({
  src: [
    { path: "./fuentes/inter-400.woff2", weight: "400", style: "normal" },
    { path: "./fuentes/inter-500.woff2", weight: "500", style: "normal" },
    { path: "./fuentes/inter-600.woff2", weight: "600", style: "normal" },
    { path: "./fuentes/inter-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-inter",
});

export const jetbrainsMono = localFont({
  src: [
    { path: "./fuentes/mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fuentes/mono-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-mono",
});