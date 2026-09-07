import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { AppHeader } from "@/components/AppHeader";
import { NavBar } from "@/components/NavBar";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

// Self-hosted at build time by next/font — no third-party request at runtime, and no
// layout shift from a late-arriving webfont.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Line Tracker",
  description: "NCAAF and NFL line movement, graded against what actually happened.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Lines" },
};

export const viewport: Viewport = {
  themeColor: "#08090d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh font-sans antialiased">
        <AppHeader />
        <main className="mx-auto w-full max-w-3xl px-3 pb-28 pt-3">{children}</main>
        <NavBar />
        <ServiceWorker />
      </body>
    </html>
  );
}
