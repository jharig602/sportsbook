import type { Metadata, Viewport } from "next";

import { themeFor } from "@/lib/favourites";
import { getFavourites } from "@/lib/settings-db";
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
  title: "Dissent",
  description:
    "Finds the one sportsbook that disagrees with the others, and says so only when the gap is real.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Dissent" },
};

export const viewport: Viewport = {
  themeColor: "#08090d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read here rather than per page so the accent is consistent everywhere, and tolerant
  // of a missing database: no favourites simply means the default blue.
  const theme = themeFor(await getFavourites().catch(() => []));

  return (
    <html lang="en" className={inter.variable}>
      {/*
        One favourite team recolours the accent, and only the accent.
        Backgrounds and text stay put: a team palette applied to those produces an
        interface that is on-brand and unreadable, and the numbers here are the whole
        point of the page. Every colour in `favourites.ts` was picked to sit on the
        existing dark ground rather than copied from a brand guide, for that reason.
      */}
      <body
        className="min-h-dvh font-sans antialiased"
        style={
          theme
            ? ({
                "--color-accent": theme.accent,
                "--color-accent-dim": theme.muted,
              } as React.CSSProperties)
            : undefined
        }
      >
        <AppHeader />
        <main className="mx-auto w-full max-w-3xl px-3 pb-28 pt-3">{children}</main>
        <NavBar />
        <ServiceWorker />
      </body>
    </html>
  );
}
