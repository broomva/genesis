import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Monorepo root (two levels up from apps/web). Resolved from this file's URL so
// it is correct in a git worktree locally AND on the VPS, with no hardcoded path.
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const nextConfig: NextConfig = {
  // Self-contained server bundle for the systemd `genesis-web` deploy on the VPS
  // (`.next/standalone` → `node server.js`, no monorepo install needed).
  output: "standalone",
  // In a monorepo, point Next/Turbopack at the real workspace root so dependency
  // tracing includes hoisted deps and Turbopack does not mis-infer the root.
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
};

export default nextConfig;
