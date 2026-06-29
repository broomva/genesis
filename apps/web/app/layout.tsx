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
      {/* h-full (percentage → the ICB / full screen under viewport-fit=cover),
          NOT h-dvh: on iOS standalone `100dvh` resolves to the SAFE content area
          (excluding the home-indicator region), shorter than the physical screen,
          and the overflow-hidden body then clips the `fixed inset-0` shell short —
          leaving a blank band below the composer (BRO-1603). The percentage chain
          (html h-full → body h-full) matches the shell's ICB basis exactly; the
          footer's pb-[env(safe-area-inset-bottom)] lifts the composer above the
          home indicator. overflow-hidden: the chat manages its own scroll. */}
      <body className="bg-background text-foreground h-full overflow-hidden">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
