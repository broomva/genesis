import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/service-worker";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Genesis",
  description: "Genesis agent chat — a local-first PWA channel.",
  applicationName: "Genesis",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Genesis",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d12",
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
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* h-dvh (dynamic viewport) so the chat column reaches the PHYSICAL bottom
          under viewport-fit=cover — `min-h-full` (= layout viewport, excludes the
          iOS home-indicator inset) left a dead band below the composer (BRO-1582).
          overflow-hidden: the chat manages its own scroll regions. */}
      <body className="bg-background text-foreground h-dvh overflow-hidden">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
