// Pure recall arithmetic for the composer input-history stack (BRO-1598). Kept
// out of the React hook so the index math — the bug-prone part — is unit-tested
// in isolation, without a component test harness.

/** One ArrowUp/ArrowDown step over the user-message history.
 *
 *  @param history user-message texts, OLDEST → NEWEST.
 *  @param index   current recall index: -1 = the live draft (not recalling),
 *                 0 = most recent message, 1 = the one before, …
 *  @param dir     "older" (ArrowUp) walks back; "newer" (ArrowDown) walks toward
 *                 the draft.
 *  @returns the next index + the text to show. "newer" off the top returns
 *           index -1 with "" (back to the empty draft). Clamps at the oldest.
 */
export function recallStep(
  history: readonly string[],
  index: number,
  dir: "older" | "newer",
): { index: number; text: string } {
  if (history.length === 0) return { index: -1, text: "" };
  const at = (i: number) => history[history.length - 1 - i] ?? "";
  if (dir === "older") {
    const next = Math.min(index + 1, history.length - 1);
    return { index: next, text: at(next) };
  }
  const next = index - 1;
  return { index: next, text: next < 0 ? "" : at(next) };
}
