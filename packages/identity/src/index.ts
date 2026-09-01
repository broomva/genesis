// One human, one id — across every channel that carries a phone number.
//
// This existed FIVE times, under four names, in four files:
//
//   apps/api/src/voice.ts        normalizeCallerId
//   apps/chat-bot/src/allowlist.ts  normalizePhone
//   apps/chat-bot/src/operator.ts   normalizeId
//   apps/chat-bot/src/operator.ts   inline, on the operator env var
//   scripts/tenants.ts              normalize
//
// The first two carried identical doc comments and an explicit note that they
// "MUST agree". What guarded that was a test in voice.test.ts named DRIFT GUARD
// which re-implemented the rule inline rather than importing the other one — so
// with `normalizePhone` mutated to a completely different rule it still reported
// 14 pass / 0 fail. It could not detect the drift it was named for.
//
// The third pair was undocumented: operator.ts compares its normalized env var
// against `principal.id`, which for kapso came from `normalizePhone`. Three
// pairs that had to agree, one guard, and the guard was a mirror.
//
// The failure mode if they disagree is stated in the original comment and is
// worth keeping in front of whoever changes this: a caller whose number IS
// allowlisted resolves as unknown and silently drops to take-a-message. Nothing
// errors. It presents as absence.
//
// The fix is not a better guard. With one implementation the drift class stops
// existing, so the guard was deleted rather than repaired.

/**
 * Digits-only form of a phone number: `"+57 300 123-4567"` -> `"573001234567"`.
 *
 * It strips non-digits and does nothing else. That is enough to make "one
 * principal per human" hold across WhatsApp, Telegram and the voice line for the
 * spellings that actually arrive — `+57 300 123-4567`, `573001234567`,
 * `57-300-1234567`, `tel:+57...` — because those differ only in punctuation.
 *
 * It is NOT a canonicaliser of dialling forms, and the difference matters:
 *
 * ```
 * "+57 300 123 4567"   -> "573001234567"
 * "0057 300 123 4567"  -> "00573001234567"   SAME HUMAN, DIFFERENT ID
 * "(300) 123-4567"     -> "3001234567"       SAME HUMAN, DIFFERENT ID
 * ```
 *
 * `00` is the standard alternate international prefix and a national-format
 * number omits the country code entirely, so both are reachable from an operator
 * pasting a number. Both fail CLOSED — the id simply never matches, so the caller
 * is treated as unknown rather than as someone else — which is why this is a
 * documented limit rather than a bug. Do not "fix" it by stripping leading zeros:
 * that would merge `0057…` into `57…` and can join two distinct principals. There
 * is a test pinning the current behaviour so that change cannot be made silently.
 *
 * Three more properties worth knowing before you change it:
 *
 * - **It is not a validator.** Garbage in yields `""`, and an empty id is a
 *   dangerous thing to route on — `voice-queue.ts` says so explicitly. Callers
 *   must reject `""` themselves; this function will not do it for them. Most do.
 *   One does not: `allowlist.ts`'s bare-entry branch in `principalOf` builds a
 *   principal without an emptiness check, so a non-digit bare kapso entry becomes
 *   `{kapso, ""}`. Pre-existing and low-reachability (real kapso thread ids are
 *   colon-prefixed and take the branch that does check), recorded here rather
 *   than left for the next reader to find.
 * - **`\D` is ASCII-digit-relative.** Arabic-Indic digits (`"٣٤٥"`) are stripped
 *   entirely rather than transliterated, so such a number normalizes to `""` and
 *   is rejected by the emptiness check rather than silently mis-routed. That is
 *   the safe direction, and it is a deliberate limit rather than an oversight.
 */
export function normalizePhoneId(value: string): string {
  return value.replace(/\D/g, "");
}
