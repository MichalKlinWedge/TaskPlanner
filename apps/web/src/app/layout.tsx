import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { THEME_SCRIPT } from "@/lib/theme-script";

// `latin-ext` — polskie znaki (ą, ę, ł…) z tej samej czcionki, a nie z zastępczej.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: "TaskPlanner",
  description: "Zadania codzienne: listy, kanban, kalendarz i oś czasu",
  // Potwierdzenie własności domeny w Google Search Console (weryfikacja aplikacji OAuth):
  // wartość `content` z meta-tagu w zmiennej projektu Vercel GOOGLE_SITE_VERIFICATION.
  ...(process.env.GOOGLE_SITE_VERIFICATION ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } } : {}),
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pl" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Motyw przed pierwszym malowaniem; `suppressHydrationWarning` — skrypt dopisuje `data-theme`. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* Rozszerzenia przeglądarki dopisują atrybuty do <body> przed hydratacją. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
