#!/usr/bin/env bun
// Capacity eval (BRO-2260 / BRO-2275) — prove the bounds are EFFECTIVE, not just
// applied.
//
//   bun scripts/capacity-eval.ts [--url http://localhost:8787] [--workspace ws-wa-…]
//
// BRO-2275 shipped cgroup limits and said so honestly: "verified as applied, not
// as effective — no run has yet been made to hit the ceiling and confirm the
// listener stays responsive. That is the check that would actually prove the
// design." This is that check.
//
// WHAT THE INCIDENT ACTUALLY WAS. Not an OOM. On 2026-08-23 a tenant's turn sat at
// 100% CPU and ~8 GB for two and a half hours; nothing was killed, the box simply
// had no capacity left, the webhook listener could not answer inside Kapso's
// delivery timeout, and three messages were LOST — Kapso retries three times and
// then drops. So the property under test is not "memory stays low". It is:
//
//   while the compute surface is saturated, the INGRESS still answers in time.
//
// EXIT CODES — 0 pass, 1 fail, 2 INVALID.
//
// 2 exists because this eval can lie in the same direction as the thing it grades.
// If the api is already down, every probe "fails to saturate" and a naive script
// would report a clean pass for a dead system. Controls run FIRST and a control
// failure is INVALID, never pass and never fail. A denial is evidence only when
// the apparatus could have said otherwise.

export {}; // top-level await needs this file to be a module

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};

const URL_BASE = flag("url", process.env.GENESIS_URL ?? "http://localhost:8787").replace(/\/$/, "");
const WORKSPACE = flag("workspace", "");
const TOKEN = process.env.GENESIS_TOKEN;
/** How many turns to fire at once — deliberately above any sane global cap. */
const FANOUT = Number(flag("fanout", "6"));
/** Kapso fails a delivery past roughly this; the listener must beat it. */
const INGRESS_BUDGET_MS = Number(flag("ingress-budget-ms", "5000"));

const auth: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  rows.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    // AWAIT FIRST (P20 round 4 blocker). Object-literal properties evaluate in
    // order, so `{ ms: Date.now() - t0, value: await fn() }` computed the elapsed
    // time BEFORE the request ran: every probe recorded ~0ms and the ingress
    // latency assertion — this file's central claim — could never fail. A
    // measurement apparatus that cannot report a bad number is worse than none,
    // because it certifies the thing it was built to catch.
    const value = await fn();
    return { ms: Date.now() - t0, value };
  } catch (e) {
    return { ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The ingress probe. `/health` is what must stay answerable under load. */
async function health(): Promise<number> {
  const res = await fetch(`${URL_BASE}/health`, {
    headers: auth,
    signal: AbortSignal.timeout(INGRESS_BUDGET_MS * 2),
  });
  return res.status;
}

/** Start one turn. Resolves when the stream ends OR the request is refused. */
async function turn(prompt: string): Promise<{ refused: boolean; status: number; body: string }> {
  const res = await fetch(`${URL_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      id: `capacity-eval-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`,
      messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
      ...(WORKSPACE ? { workspaceId: WORKSPACE } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.text();
  // A NON-OK RESPONSE IS NOT A TURN (P20 round 4 major). Counting a 500 as an
  // admitted run let a broken backend satisfy both the control ("one turn runs")
  // and the "did not refuse everything" assertion — the eval would certify a
  // server that was simply erroring.
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  // A refusal surfaces as the gate's message inside the stream.
  const refused = /already have|at capacity/i.test(body);
  return { refused, status: res.status, body: body.slice(0, 400) };
}

console.log(`capacity eval → ${URL_BASE}${WORKSPACE ? ` (workspace ${WORKSPACE})` : ""}`);
console.log(`  fanout=${FANOUT}  ingress budget=${INGRESS_BUDGET_MS}ms\n`);

// ── CONTROLS FIRST ──────────────────────────────────────────────────────────
console.log("controls:");
const baseline = await timed(health);
if (baseline.error || baseline.value !== 200) {
  console.error(
    `\nINVALID: the api is not answering /health before the test even starts (${baseline.error ?? `HTTP ${baseline.value}`}).\nEverything below would 'fail to saturate' and a pass here would mean nothing.`,
  );
  process.exit(2);
}
record("ingress answers at rest", true, `HTTP 200 in ${baseline.ms}ms`);

const single = await timed(() => turn("Reply with the single word: ok"));
if (single.error || !single.value || single.value.refused) {
  console.error(
    `\nINVALID: a SINGLE turn could not run (${single.error ?? "refused"}).\nIf one turn cannot start, 'the gate refused the rest' is not evidence of anything.`,
  );
  process.exit(2);
}
record("one turn runs at rest", true, `completed in ${single.ms}ms`);

// ── SATURATE ────────────────────────────────────────────────────────────────
console.log("\nunder load:");
const busyPrompt =
  "Run this exact shell command and report nothing else: for i in $(seq 1 60); do echo working; sleep 1; done";
// Keep the ERROR, do not swallow it (P20 round 5). Mapping failures to `undefined`
// meant four HTTP 500s alongside one admitted turn and one refusal still produced a
// passing evaluation — the eval would certify a broken backend as a working bound.
const inflight = Array.from({ length: FANOUT }, () =>
  turn(busyPrompt).then(
    (r) => ({ ok: true as const, ...r }),
    (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  ),
);

// Give the fan-out a moment to actually occupy the box before probing ingress.
await new Promise((r) => setTimeout(r, 3000));

const probes: number[] = [];
for (let i = 0; i < 5; i++) {
  const p = await timed(health);
  probes.push(p.error ? Number.POSITIVE_INFINITY : p.ms);
  await new Promise((r) => setTimeout(r, 1000));
}
const worst = Math.max(...probes);

// THE PROPERTY. Not "memory stayed low" — the ingress kept answering while the
// compute surface was saturated. That is what was actually lost in the incident.
record(
  "ingress stays answerable while saturated",
  worst <= INGRESS_BUDGET_MS,
  `worst /health ${Number.isFinite(worst) ? `${worst}ms` : "NO RESPONSE"} of budget ${INGRESS_BUDGET_MS}ms`,
);

const settled = await Promise.all(inflight);
const errored = settled.filter((r) => !r.ok);
const refused = settled.filter((r) => r.ok && r.refused).length;
const ran = settled.filter((r) => r.ok && !r.refused).length;

// An HTTP failure is neither an admitted turn nor a refusal — it is the backend
// breaking, and counting it as either would let a 500-ing server pass.
record(
  "no turn failed with a transport/HTTP error",
  errored.length === 0,
  errored.length === 0
    ? `${FANOUT} requests, none errored`
    : `${errored.length} errored: ${errored
        .map((e) => ("error" in e ? e.error : "?"))
        .join(" | ")
        .slice(0, 200)}`,
);

// The gate must REFUSE the excess rather than admit it. Both halves matter: all
// refused would mean the gate is stuck closed; none refused means it is absent.
record(
  "the gate refused the excess rather than admitting it",
  refused > 0,
  `${ran} ran, ${refused} refused of ${FANOUT}`,
);
record(
  "the gate did not refuse everything",
  ran > 0,
  `${ran} turn(s) were admitted — a gate that admits nothing is an outage`,
);

const after = await timed(health);
record(
  "ingress recovers after the load",
  !after.error && after.value === 200,
  after.error ?? `HTTP ${after.value} in ${after.ms}ms`,
);

const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
if (failed.length > 0) {
  console.error(`FAIL: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
console.log("PASS — the bounds are effective, not merely applied.");
