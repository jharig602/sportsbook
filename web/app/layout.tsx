import type { Metadata, Viewport } from "next";

import { NavBar } from "@/components/NavBar";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Line Tracker",
  description: "NCAAF and NFL line movement, graded against what actually happened.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Lines" },
};

export const viewport: Viewport = {
  themeColor: "#0b0f16",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <main className="mx-auto w-full max-w-3xl px-3 pb-28 pt-4">{children}</main>
        <NavBar />
        <ServiceWorker />
      </body>
    </html>
  );
}
