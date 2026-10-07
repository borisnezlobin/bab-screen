import type { Metadata } from "next";
import { Barlow, Barlow_Semi_Condensed } from "next/font/google";
import "./globals.css";

const barlow = Barlow({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-barlow", display: "swap" });
const barlowNarrow = Barlow_Semi_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-barlow-narrow", display: "swap" });

export const metadata: Metadata = {
  title: "B@B wallboard",
  description: "Live markets, news, music and Spotbot for the Blockchain at Berkeley clubroom.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowNarrow.variable}`}>
      <body>{children}</body>
    </html>
  );
}
