"use client";

import { PhoneIncoming } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

/** What became of one recorded call request. Mirrors the api's VoiceQueueEntry. */
export interface VoiceQueueEntry {
  id: string;
  callerId: string;
  deliverTo?: string;
  request: string;
  createdAt: string;
  status: "pending" | "delivered" | "undeliverable" | "retrying" | "abandoned";
  attempts: number;
  lastAttemptAt?: string;
  reason?: string;
}

/** Human wording per status. The failure cases carry WHY, because "failed" alone
 *  sends an operator to the logs — which is the thing this panel exists to
 *  replace. A closed window especially: it is not a bug and retrying cannot fix
 *  it, and that is not guessable from the word "failed". */
const EXPLAIN: Record<VoiceQueueEntry["status"], string> = {
  pending: "recorded, not yet answered",
  delivered: "answered on WhatsApp",
  undeliverable: "caller not recognised — nowhere to send an answer",
  retrying: "delivery failed, will try again",
  abandoned: "gave up after repeated failures",
};

const TONE: Record<VoiceQueueEntry["status"], string> = {
  pending: "bg-muted text-muted-foreground",
  delivered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  undeliverable: "bg-muted text-muted-foreground",
  retrying: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  abandoned: "bg-destructive/15 text-destructive",
};

function reasonText(e: VoiceQueueEntry): string | undefined {
  if (!e.reason) return undefined;
  if (e.reason === "window-closed") {
    // The one an operator will actually hit, and the one that reads as a bug
    // unless it is spelled out: a phone call does not open WhatsApp's 24h window.
    return "WhatsApp's 24-hour window is closed — a call does not open it, so they must message us first";
  }
  if (e.reason === "dispatch") return "the agent turn failed";
  if (e.reason === "send") return "the WhatsApp send failed";
  return e.reason;
}

/** Recent phone requests and what became of them (BRO-2284).
 *
 *  SELF-HIDES when the voice channel is not configured — the api only registers
 *  the endpoint when a queue directory is set, so on a deploy without voice this
 *  renders nothing rather than an empty box or an error. Same rule the workspaces
 *  manager follows. */
export function VoiceQueue({ open }: { open: boolean }) {
  const [entries, setEntries] = useState<VoiceQueueEntry[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  /** A real failure, as opposed to "voice is not configured here". */
  const [error, setError] = useState<string | null>(null);
  /** The server could not read a journal — the numbers below are incomplete. */
  const [degraded, setDegraded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/voice/queue", { cache: "no-store" });
      if (res.status === 404) {
        // The channel is not configured here — the api does not register the
        // route at all. Nothing to show, and nothing wrong.
        setAvailable(false);
        return;
      }
      if (!res.ok) {
        // Anything ELSE is a real failure and must not masquerade as "no voice
        // configured": silently removing a diagnostic panel during an outage is
        // exactly when an operator needs it. 401 usually means the api has no
        // GENESIS_TOKEN, without which this route is deliberately not served.
        setAvailable(true);
        setError(
          res.status === 401
            ? "Not authorised. This panel needs GENESIS_TOKEN set on the engine."
            : `Could not load the queue (HTTP ${res.status}).`,
        );
        return;
      }
      const body = (await res.json()) as {
        entries?: VoiceQueueEntry[];
        degraded?: string;
      };
      setEntries(body.entries ?? []);
      setDegraded(body.degraded ?? null);
      setError(null);
      setAvailable(true);
    } catch (e) {
      setAvailable(true);
      setError(e instanceof Error ? e.message : "Could not reach the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Only fetch while the sheet is open — this is a panel nobody is looking at
  // most of the time, and it reads two files on the server per call.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!available) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <PhoneIncoming className="size-4 shrink-0" aria-hidden />
        <span>Phone requests</span>
        {loading ? <Spinner className="size-3" /> : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {degraded ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Incomplete: {degraded}. Some rows may be wrong.
        </p>
      ) : null}
      {!error && entries && entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing yet. A call recorded here is answered over WhatsApp.
        </p>
      ) : null}
      <ul className="space-y-2">
        {(entries ?? []).slice(0, 12).map((e) => {
          const why = reasonText(e);
          return (
            <li key={e.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 font-medium">{e.request}</span>
                <Badge className={`shrink-0 ${TONE[e.status]}`}>{e.status}</Badge>
              </div>
              <p className="mt-1 text-muted-foreground">{EXPLAIN[e.status]}</p>
              {why ? <p className="mt-0.5 text-muted-foreground">{why}</p> : null}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}
                {e.attempts > 0 ? ` · ${e.attempts} attempt${e.attempts === 1 ? "" : "s"}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
