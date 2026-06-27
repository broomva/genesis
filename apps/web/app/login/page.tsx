"use client";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
// Single-user passkey login — arcan-glass styled (reuses the dark theme tokens
// from globals.css: bg #0b0d12, panel #11151f / --card, accent #7aa2ff /
// --ai-blue).
//
// Two affordances:
//   1. Sign in with passkey — `authClient.signIn.passkey()`. The normal path
//      once the owner has enrolled a credential.
//   2. First-run setup (bootstrap) — POST the AUTH_BOOTSTRAP_TOKEN to
//      /api/auth/bootstrap, which creates the owner + a session, then enroll the
//      first passkey via `authClient.passkey.addPasskey()`. Shown as an
//      expandable "first run" path; it succeeds only once (server returns 409
//      after an owner exists).
//
// On success → redirect to `/`.
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");

  async function onPasskeySignIn() {
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) {
        setError(res.error.message ?? "Passkey sign-in failed.");
        return;
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onBootstrap(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const token = bootstrapToken.trim();
    if (!token) {
      setError("Enter the bootstrap token.");
      return;
    }
    setBusy(true);
    try {
      // 1) Create the owner + an authenticated session (sets the session cookie).
      const res = await fetch("/api/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setError(
          res.status === 409
            ? "An owner already exists — use passkey sign-in."
            : res.status === 401
              ? "Invalid bootstrap token."
              : ((detail as { error?: string }).error ?? "Bootstrap failed."),
        );
        return;
      }
      // 2) Now authenticated: enroll the first passkey for this owner.
      const enroll = await authClient.passkey.addPasskey({ name: "Genesis owner" });
      if (enroll?.error) {
        setError(
          `Owner created, but passkey enrollment failed: ${enroll.error.message ?? "unknown"}`,
        );
        return;
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bootstrap failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center px-4">
      <main className="bg-card border-border w-full max-w-sm rounded-xl border p-6 shadow-lg">
        <div className="mb-6 flex items-center gap-2">
          <span className="font-mono text-base font-semibold tracking-tight text-[var(--ai-blue)]">
            Genesis
          </span>
          <span className="text-muted-foreground font-mono text-xs">sign in</span>
        </div>

        <Button
          type="button"
          className="w-full"
          disabled={busy}
          onClick={onPasskeySignIn}
          aria-label="Sign in with passkey"
        >
          {busy ? "…" : "Sign in with passkey"}
        </Button>

        {error ? (
          <p className="text-destructive mt-4 font-mono text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <div className="border-border mt-6 border-t pt-4">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground font-mono text-xs underline-offset-4 hover:underline"
            onClick={() => setShowBootstrap((v) => !v)}
            aria-expanded={showBootstrap}
          >
            First run? Set up the owner →
          </button>

          {showBootstrap ? (
            <form onSubmit={onBootstrap} className="mt-3 flex flex-col gap-2">
              <label htmlFor="bootstrap-token" className="text-muted-foreground font-mono text-xs">
                Bootstrap token
              </label>
              <input
                id="bootstrap-token"
                type="password"
                value={bootstrapToken}
                onChange={(e) => setBootstrapToken(e.target.value)}
                placeholder="AUTH_BOOTSTRAP_TOKEN"
                autoComplete="off"
                className={cn(
                  "bg-background border-border placeholder:text-muted-foreground rounded-lg border px-3 py-2 text-sm",
                  "focus-visible:border-ring focus-visible:ring-ring/40 outline-none focus-visible:ring-2",
                )}
              />
              <Button type="submit" variant="outline" className="w-full" disabled={busy}>
                {busy ? "…" : "Create owner + enroll passkey"}
              </Button>
              <p className="text-muted-foreground font-mono text-[0.7rem] leading-relaxed">
                One-time only. Creates the single owner and registers this device&apos;s passkey.
              </p>
            </form>
          ) : null}
        </div>
      </main>
    </div>
  );
}
