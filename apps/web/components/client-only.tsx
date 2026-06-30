"use client";

import { type ReactNode, useEffect, useState } from "react";

// Render children only AFTER mount (BRO-1618). Used to keep client-only hooks —
// notably Better Auth's `useSession`, which is not server-render-safe — out of
// the SSR/prerender pass entirely: during SSR the children (and their hooks)
// never render, only the static `fallback` does.
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <>{mounted ? children : fallback}</>;
}
