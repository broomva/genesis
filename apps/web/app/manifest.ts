import type { MetadataRoute } from "next";

// Next metadata route → /manifest.webmanifest. Drives PWA installability.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Genesis",
    short_name: "Genesis",
    description: "Genesis agent chat — a local-first PWA channel.",
    start_url: "/",
    display: "standalone",
    // Light is the default canvas (the DS signature). The splash/background and
    // chrome tint match it; dark mode is an in-app toggle, not a manifest switch.
    background_color: "#ffffff",
    theme_color: "#ffffff",
    orientation: "portrait",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      // Two raster purposes: a plain "any" icon (platforms that ignore the SVG
      // and would over-crop a maskable) + a "maskable" adaptive icon (Android).
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
