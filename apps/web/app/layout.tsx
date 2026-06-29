import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorker } from "@/components/service-worker";
import { THEME_INIT_SCRIPT } from "@/components/theme-toggle";

export const metadata: Metadata = {
  title: "Genesis",
  description: "Genesis agent chat — a local-first PWA channel.",
  applicationName: "Genesis",
  appleWebApp: {
    capable: true,
    // Light is the default canvas, so the status bar shows dark glyphs over an
    // opaque light bar ("default"). black-translucent would draw white glyphs
    // that vanish on the white canvas.
    statusBarStyle: "default",
    title: "Genesis",
  },
};

export const viewport: Viewport = {
  // Tracks the OS scheme for the standalone status-bar tint. The in-app toggle is
  // class-based and authoritative for the page itself; this is just chrome.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e16" },
  ],
  width: "device-width",
  initialScale: 1,
  // No maximumScale clamp — let users pinch-zoom (WCAG 1.4.4).
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: THEME_INIT_SCRIPT mutates the class on <html>
    // before React hydrates (no-flash), so the server/client class can differ.
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint — no light→dark flash. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static, app-authored theme bootstrap; no user input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* h-dvh (dynamic viewport) so the chat column reaches the PHYSICAL bottom
          under viewport-fit=cover. overflow-hidden: the chat manages its own
          scroll regions. The app shell pins itself with `fixed inset-0` (page.tsx)
          — the bulletproof full-screen technique for iOS standalone (BRO-1582). */}
      <body className="bg-background text-foreground h-dvh overflow-hidden">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
