// Server-side per-user preferences persistence (BRO-1618). Reads/writes the
// `settings` JSON column on the Better Auth `user` row directly via Drizzle (not
// through Better Auth's user API) — co-located with the user, always pglite.
//
// SERVER ONLY: imports the auth pglite handle. Never import from a client
// component; the client uses use-preferences (localStorage + /api/settings).

import { authDb, ensureAuthDb } from "@/lib/auth";
import { user } from "@/lib/auth-schema";
import { DEFAULT_PREFERENCES, type Preferences, sanitizePreferences } from "@/lib/preferences";
import { eq } from "drizzle-orm";

/** The signed-in user's saved preferences, sanitized. Missing row or unparseable
 *  blob → the defaults (never throws). */
export async function getPreferences(userId: string): Promise<Preferences> {
  await ensureAuthDb();
  const rows = await authDb
    .select({ settings: user.settings })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const raw = rows[0]?.settings;
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    return sanitizePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Merge a partial update over the current saved prefs and persist. Returns the
 *  full sanitized result. A no-op if the user row is absent (update WHERE misses
 *  → 0 rows), which never happens for the single owner. */
export async function upsertPreferences(
  userId: string,
  partial: Partial<Preferences>,
): Promise<Preferences> {
  await ensureAuthDb();
  const current = await getPreferences(userId);
  const next = sanitizePreferences({ ...current, ...partial });
  await authDb
    .update(user)
    .set({ settings: JSON.stringify(next) })
    .where(eq(user.id, userId));
  return next;
}
