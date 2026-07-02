// Engine capability gating (BRO-1622). ENGINE_OPTIONS lists every engine, but the
// server only REGISTERS a runner the box can actually run (codex needs the binary on
// PATH; interactive needs a local host). Picking an unregistered engine silently
// sticky-binds the thread to the default — forever. GET /health advertises the real
// set (`engines`); the client gates the picker on it so a wrong-engine bind is
// impossible from the UI. Fetch failure degrades OPEN (show all), never closed.

import type { SelectOption } from "./chat-options";

/** What the backend advertises it can run (GET /api/engines → engine /health). */
export interface EngineCapabilities {
  engines: string[];
  defaultEngine: string;
}

/** Fetch the engines the SERVER can actually run. Returns null on ANY failure (or an
 *  empty/unknown set) so the caller degrades OPEN — a transient capability-fetch error
 *  must never hide every option and wedge the picker. */
export async function fetchAvailableEngines(signal?: AbortSignal): Promise<string[] | null> {
  try {
    const res = await fetch("/api/engines", { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { engines?: unknown };
    if (!Array.isArray(data.engines)) return null;
    const engines = data.engines.filter((e): e is string => typeof e === "string" && e.length > 0);
    return engines.length > 0 ? engines : null; // empty → treat as unknown → degrade open
  } catch {
    return null;
  }
}

/** A picker option annotated with availability (BRO-1622). */
export type GatedOption = SelectOption & { disabled?: boolean };

/** Gate options on the backend-advertised set. `advertised === null` (unknown / fetch
 *  failed) → every option enabled (degrade OPEN). Otherwise an option not in the set
 *  is marked `disabled` — SHOWN, not hidden, so the user sees the engine exists but
 *  can't sticky-bind a thread to one the box lacks. */
export function gateEngineOptions(
  all: readonly SelectOption[],
  advertised: string[] | null,
): GatedOption[] {
  if (advertised === null) return all.map((o) => ({ ...o }));
  const set = new Set(advertised);
  return all.map((o) => ({ ...o, disabled: !set.has(o.value) }));
}

/** Is `engine` runnable per the advertised set? `advertised === null` → assume yes
 *  (degrade open). Used to surface a persisted pref that points at an unavailable
 *  engine (so the UI can note it rather than silently switch). */
export function isEngineAvailable(engine: string, advertised: string[] | null): boolean {
  return advertised === null || advertised.includes(engine);
}
