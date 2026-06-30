"use client";

import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

// Avatar + name/email identity (BRO-1618). The real variant calls `useSession`,
// so it MUST be rendered inside <ClientOnly> (useSession is not server-render-
// safe). The Fallback variant is hook-free and serves as the SSR/pre-mount
// placeholder.

function Avatar({
  name,
  image,
  compact,
}: {
  name?: string | null;
  image?: string | null;
  compact: boolean;
}) {
  const size = compact ? "size-7 text-xs" : "size-9 text-sm";
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element — remote avatar, no loader config.
    return <img src={image} alt="" className={cn("shrink-0 rounded-full object-cover", size)} />;
  }
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "bg-[var(--bv-frost-8)] text-muted-foreground flex shrink-0 items-center justify-center rounded-full font-medium",
        size,
      )}
    >
      {initial}
    </span>
  );
}

function IdentityBlock({
  primary,
  secondary,
  image,
  name,
  compact,
}: {
  primary: string;
  secondary: string;
  image?: string | null;
  name?: string | null;
  compact: boolean;
}) {
  return (
    <>
      <Avatar name={name} image={image} compact={compact} />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{primary}</span>
        <span className="text-muted-foreground block truncate text-xs">{secondary}</span>
      </span>
    </>
  );
}

/** Hook-free placeholder — the SSR / pre-mount fallback. */
export function AccountIdentityFallback({ compact = false }: { compact?: boolean }) {
  return (
    <IdentityBlock
      compact={compact}
      primary={compact ? "Settings" : "Account"}
      secondary={compact ? "Preferences" : "—"}
    />
  );
}

/** Real identity from the session — CLIENT ONLY (wrap in <ClientOnly>). */
export function AccountIdentity({ compact = false }: { compact?: boolean }) {
  const { data: session } = useSession();
  const user = session?.user;
  return (
    <IdentityBlock
      compact={compact}
      name={user?.name}
      image={user?.image}
      primary={user?.name ?? (compact ? "Settings" : "Signed in")}
      secondary={compact ? "Settings and account" : (user?.email ?? "—")}
    />
  );
}
