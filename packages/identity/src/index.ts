// One human, one id — across every channel that carries a phone number.
//
// This existed four times, under four names, in three files:
//
//   apps/api/src/voice.ts        normalizeCallerId
//   apps/chat-bot/src/allowlist.ts  normalizePhone
//   apps/chat-bot/src/operator.ts   normalizeId
//   apps/chat-bot/src/operator.ts   inline, on the operator env var
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
 * Every spelling of one number reduces to one id, which is what makes "one
 * principal per human" true across WhatsApp, Telegram and the voice line.
 *
 * Two properties worth knowing before you change it:
 *
 * - **It is not a validator.** Garbage in yields `""`, and an empty id is a
 *   dangerous thing to route on — `voice-queue.ts` says so explicitly. Callers
 *   must reject `""` themselves; this function will not do it for them.
 * - **`\D` is ASCII-digit-relative.** Arabic-Indic digits (`"٣٤٥"`) are stripped
 *   entirely rather than transliterated, so such a number normalizes to `""` and
 *   is rejected by the emptiness check rather than silently mis-routed. That is
 *   the safe direction, and it is a deliberate limit rather than an oversight.
 */
export function normalizePhoneId(value: string): string {
  return value.replace(/\D/g, "");
}
