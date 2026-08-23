import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source assertion, matching apps/api/src/index-wiring.test.ts: index.ts starts the
// bot at import, so its dispatch order cannot be exercised in a unit test. The order
// is what carries the invariant, and it is visible in the source.
const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("DM dispatch order (BRO-2245)", () => {
  test("operator commands are handled BEFORE tenant admission", () => {
    // The deadlock this prevents: with an empty registry the operator's own first
    // message creates a PENDING record, admitThread returns false, and every later
    // message stops before maybeHandleOperator runs -- so the only person who can
    // approve tenants can never issue the command that does it.
    // Match CALL SITES, not bare names: the explanatory comment above the handler
    // mentions admitThread, and an earlier version of this test found that instead
    // of the code and failed on prose.
    const body = SRC.slice(SRC.indexOf("chat.onDirectMessage("));
    const operatorAt = body.indexOf("await maybeHandleOperator(");
    const admitAt = body.indexOf("await admitThread(");
    expect(operatorAt).toBeGreaterThan(-1);
    expect(admitAt).toBeGreaterThan(-1);
    expect(operatorAt).toBeLessThan(admitAt);
  });

  test("POSITIVE CONTROL — admission is still called on the DM path", () => {
    // Without this, DELETING admitThread from the handler would satisfy the test
    // above: "operator comes first" is trivially true when nothing follows it.
    const body = SRC.slice(SRC.indexOf("chat.onDirectMessage("));
    const handler = body.slice(0, body.indexOf("});"));
    expect(handler).toContain("await admitThread(");
    expect(handler).toContain("await handleAgentMessage(");
  });

  test("maybeHandleOperator authenticates on its own — it does not lean on admission", () => {
    // The reorder is only safe because of this. If the isOperator gate were ever
    // removed, running the handler before admission would expose operator commands
    // to unadmitted senders.
    const fn = SRC.slice(SRC.indexOf("async function maybeHandleOperator"));
    const head = fn.slice(0, fn.indexOf("const cmd ="));
    expect(head).toContain("isOperator(");
    expect(head).toContain("isOperatorToken(");
  });
});
