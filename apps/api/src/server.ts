import {
  type AgentEvent,
  type ConcurrencyLimits,
  type EngineControl,
  type Store,
  Supervisor,
  type Workspace,
  type WorkspaceRepository,
} from "@genesis/core";
import type { HostProvider } from "@genesis/host";
import type { RunOptions, RunResult } from "@genesis/runner";
import { type Context, Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { type Ask, type AskAnswer, readAsks } from "./ask-log";
import { eventStream } from "./channel/bridge";
import { ChatSdkConnector } from "./channel/chat-sdk";
import type { IncomingMessage } from "./channel/types";
import { Hub } from "./hub";
import { PAGE } from "./ui";
import {
  type DeliverablePrincipal,
  type VoiceTicket,
  VoiceValidationError,
  buildTicket,
  readCallerId,
  resolveCaller,
  secretMatches,
} from "./voice";
import { readQueueStatus } from "./voice-queue";
import { browseForAdd } from "./workspace-browse";
import { workspaceChecks } from "./workspace-checks";
import {
  WorkspaceFsError,
  listWorkspaceDir,
  readWorkspaceFile,
  readWorkspaceFileRaw,
} from "./workspace-fs";
import { gitCommit, gitDiff, gitStatus } from "./workspace-git";

import {
  WorkspaceValidationError,
  availableWorkspaces,
  pathAddRoots,
  provisionFromGitUrl,
  resolvePathAdd,
  resolvePick,
} from "./workspace-provision";

const { upgradeWebSocket, websocket } = createBunWebSocket();

/** Build the reasoning INDICATOR note (BRO-1574, hardened BRO-1608). Order:
 *  1) verbatim prose if the deployment ever provides it (the real streamed
 *     reasoning) — redacted to "" under subscription/OAuth auth, so usually skipped;
 *  2) else, if the model thought (`reasoned` — set by a signature_delta / thinking
 *     block even when no token estimate exists at effort high), the honest
 *     indicator, with the `~N tokens` budget when the CLI reported it (effort max).
 *  Undefined only when no extended thinking happened at all (effort off / low). */
function reasoningNote(
  reasoned: boolean | undefined,
  tokens: number | undefined,
  prose: string | undefined,
): string | undefined {
  if (prose && prose.trim().length > 0) return prose.trim();
  if (!reasoned) return undefined;
  return tokens && tokens > 0
    ? `Extended thinking · ~${tokens} tokens (content private on this deployment)`
    : "Extended thinking (content private on this deployment)";
}

export interface BuildOpts {
  workspaceRoot: string;
  /** Display name for the built-in default workspace (id `ws-default`). Env-driven
   *  (GENESIS_WORKSPACE_NAME) so an operator can label the root something meaningful
   *  ("root", the project name) instead of the "genesis" literal. Blank/whitespace →
   *  falls back to "genesis" (backward compatible). Never affects the id or bindings. */
  workspaceName?: string;
  extraArgs?: string[];
  /** When set, /message requires `Authorization: Bearer <token>` (or ?token=). */
  token?: string;
  /** Durable store (Phase 2). Omit → in-memory (Phase 1 dev behavior). */
  store?: Store;
  /** Resolves a per-session host (Phase 4 microVM). Omit → Supervisor defaults
   *  to a LocalHost via StaticHostProvider. */
  hostProvider?: HostProvider;
  /** Working dir inside a microVM host (default /vercel/sandbox). Ignored on local. */
  remoteCwd?: string;
  /** Alternate runner (e.g. the exempt interactive engine, BRO-1488). Omit →
   *  the default print engine (`runAgent`, `claude -p`). */
  run?: (opts: RunOptions) => Promise<RunResult>;
  /** Shared secret an ElevenLabs webhook tool presents on /voice/* (BRO-2228).
   *  OMITTED → the voice routes are NOT REGISTERED AT ALL. Deliberately not
   *  "registered but open": an unconfigured deploy must 404, not answer. */
  voiceSecret?: string;
  /** Numbers the voice channel may deliver an answer to. A caller matching one
   *  gets follow-up on that number; everyone else can only leave a message. */
  voicePrincipals?: readonly DeliverablePrincipal[];
  /** Where the voice queue lives on disk. Enables the OPERATOR view at
   *  GET /admin/voice/queue — the joined state of tickets and what became of
   *  them.
   *
   *  DELIBERATELY NOT UNDER /voice. The Tailscale Funnel publishes exactly the
   *  /voice prefix to the internet so an ElevenLabs agent can reach
   *  /voice/identify and /voice/request. A queue view mounted there would put
   *  every caller's request text on the public internet behind no secret at all.
   *  This path sits outside that prefix and is gated like /threads: open on the
   *  loopback, authenticated at the BFF. */
  voiceQueueDir?: string;
  /** Sink for queued voice work. Must return fast — a caller is on the line.
   *  REQUIRED whenever voiceSecret is set; build() throws otherwise. */
  enqueueVoice?: (ticket: VoiceTicket) => Promise<void> | void;
  /** Shared secret the walkie client presents on /walkie/* (BRO-2387).
   *  OMITTED → the walkie routes are NOT REGISTERED AT ALL, same rule as
   *  voiceSecret: an unconfigured deploy must 404, not answer.
   *
   *  NOT the same secret as voiceSecret, deliberately. /voice is reachable from
   *  the public internet through the Tailscale Funnel; /walkie is not. Sharing
   *  one secret would make a leak of the internet-facing credential a leak of
   *  the operator's pending decisions too. */
  walkieSecret?: string;
  /** The ask log's write half. REQUIRED whenever walkieSecret is set; build()
   *  throws otherwise — a configured surface with no store would acknowledge an
   *  answer and discard it, which is the exact shape voiceSecret/enqueueVoice
   *  already failed in once. */
  askLog?: {
    append(ask: Ask): void;
    answer(answer: AskAnswer): void;
  };
  /** Where the ask log lives, for the READ half. Separate from voiceQueueDir on
   *  purpose: the two stores must not share a directory, so that an ask can
   *  never be mistaken for caller-originated intake. */
  askLogDir?: string;
  // NO voiceDelivery OPTION. Three designs failed here and the third failed most
  // instructively: an env string was an operator assertion, so it became a
  // {channel, deliver} object — and `deliver` had zero call sites, so passing
  // `async () => {}` still bought canFollowUp:true. A function-shaped assertion
  // is still an assertion. Until a consumer genuinely drains the queue (scope
  // item 4, blocked on #107) the promise is not merely disabled, it is
  // UNREPRESENTABLE: there is no value any caller of build() can pass to make
  // this surface offer a follow-up. The option returns together with the code
  // that honours it. (P20 Strata A, round 4.)
  /** Live-session control surface (interactive engine) → enables POST /control
   *  (reset/interrupt/status). Omit → those report "unsupported" (BRO-1493). */
  control?: EngineControl;
  /** Engine REGISTRY (BRO-1620) — per-thread engine selection. `runners` maps an
   *  engine id to its runner; `controls` the ids with a live-session control;
   *  `defaultEngine` is what a thread inherits absent a client request. `print`
   *  is always registered. Forwarded verbatim to the Supervisor. */
  runners?: Record<string, (opts: RunOptions) => Promise<RunResult>>;
  controls?: Record<string, EngineControl>;
  defaultEngine?: string;
  /** Run the agent directly in the workspace (no per-session worktree) —
   *  required for workspaces with nested git repos (BRO-1512). */
  noWorktree?: boolean;
  /** Turn admission bounds (BRO-2260) — forwarded verbatim to the Supervisor. */
  concurrency?: ConcurrencyLimits;
  /** Kill a turn after this long with no stream output (BRO-2260). */
  turnIdleTimeoutMs?: number;
  /** Kill a turn after this long in total (BRO-2260). */
  turnMaxMs?: number;
  /** Additional selectable workspaces beyond the default (BRO-1627) — the
   *  boot-discovered registry (GENESIS_PROJECTS_ROOT scan + GENESIS_WORKSPACES
   *  override). SEEDS the repository when empty; surfaced via GET /workspaces. */
  workspaces?: Workspace[];
  /** Workspace registry source (BRO-1629). Omit → in-memory, seeded from env
   *  (BRO-1627 behaviour). The FS adapter makes the registry durable + runtime-
   *  mutable (survives restart, editable from the PWA). */
  workspaceRepository?: WorkspaceRepository;
  /** The admin ALLOW-ROOT for discover→pick provisioning (BRO-1629, = GENESIS_
   *  PROJECTS_ROOT). GET /workspaces/available scans it; POST /workspaces registers
   *  a picked dir under it (server derives + validates the path — the client never
   *  names a filesystem path). Omit → no self-serve add (the picker still lists
   *  the registered set). */
  projectsRoot?: string;
  /** Per-event observability trace (print-engine parity, BRO-1524). */
  trace?: (sessionId: string, event: AgentEvent) => void;
}

export function build(opts: BuildOpts) {
  const hub = new Hub();
  const supervisor = new Supervisor({
    defaultWorkspace: {
      id: "ws-default",
      // Operator-labelled (GENESIS_WORKSPACE_NAME) — blank/whitespace → "genesis".
      name: opts.workspaceName?.trim() || "genesis",
      rootPath: opts.workspaceRoot,
    },
    workspaces: opts.workspaces,
    workspaceRepository: opts.workspaceRepository,
    hostProvider: opts.hostProvider,
    extraArgs: opts.extraArgs,
    remoteCwd: opts.remoteCwd,
    noWorktree: opts.noWorktree,
    concurrency: opts.concurrency,
    turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
    turnMaxMs: opts.turnMaxMs,
    trace: opts.trace,
    store: opts.store,
    run: opts.run,
    control: opts.control,
    runners: opts.runners,
    controls: opts.controls,
    defaultEngine: opts.defaultEngine,
    // Auto-generate semantic thread titles (BRO-1665). Degrades gracefully — a deploy
    // without a usable `claude` (e.g. codex-only) just keeps the first-prompt heuristic.
    generateTitles: process.env.GENESIS_GENERATE_TITLES !== "0",
  });

  if (opts.extraArgs?.includes("--dangerously-skip-permissions") && !opts.token) {
    console.warn(
      "[genesis] WARNING: agent runs with --dangerously-skip-permissions and /message is unauthenticated. " +
        "Bind to localhost only, or set GENESIS_TOKEN. (Phase 2 wires Better Auth.)",
    );
  }
  // Self-serve workspace mutation (BRO-1629) with no token → POST/DELETE /workspaces
  // are OPEN. Behind the web BFF (better-auth) that's fine, but a direct :8787 hit
  // could register/deregister agent working dirs under the allow-root. Warn loudly
  // (P20 Forge SF3) — set GENESIS_TOKEN, or bind :8787 to localhost/tailnet only.
  if (opts.projectsRoot && !opts.token) {
    console.warn(
      "[genesis] WARNING: GENESIS_PROJECTS_ROOT is set but GENESIS_TOKEN is not — " +
        "POST/DELETE /workspaces are unauthenticated on a direct connection. Set " +
        "GENESIS_TOKEN or ensure :8787 is not reachable beyond the BFF/tailnet.",
    );
  }
  // BRO-1666 Slice 3 (P20 HIGH-2) + BRO-1673 (P20 review finding #1): two routes are
  // OWNER-gated ONLY at the BFF — the engine can't tell a human from the agent, so it
  // applies only the bearer gate. POST /workspaces/:id/git/commit is a WRITE route
  // (commit+push to the owner's real remote); GET /workspaces/browse is a READ route
  // that discloses the host-FS layout UNDER the add-roots ($HOME) with absolute paths.
  // With no GENESIS_TOKEN, a direct :8787 caller (the on-box agent, or anything on the
  // tailnet) bypasses the owner gate on both. Hard deployment invariant: bind :8787 to
  // localhost + set GENESIS_TOKEN. (Both are still sandboxed — commit to the workspace,
  // browse to the add-roots — so this is bypass-of-owner-gate, not arbitrary-FS.)
  if (!opts.token) {
    console.warn(
      "[genesis] WARNING: POST /workspaces/:id/git/commit (write) and GET /workspaces/browse " +
        "(host-FS-layout read) are owner-gated ONLY at the BFF. With no GENESIS_TOKEN a direct " +
        ":8787 caller reaches both. Bind :8787 to localhost/tailnet-only and/or set GENESIS_TOKEN.",
    );
  }

  const app = new Hono();

  // Shared bearer gate — guards every endpoint that exposes session data when a
  // token is configured ( /message AND /threads — the latter leaks history too ).
  const unauthorized = (c: {
    req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined };
  }): boolean => {
    if (!opts.token) return false;
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : c.req.query("token");
    return bearer !== opts.token;
  };

  app.get("/", (c) => c.html(PAGE));
  // /health doubles as the capability surface (BRO-1621): `engines` is the set
  // the box can actually run, so a client can gate its engine picker instead of
  // offering one that would silently bind the default (BRO-1622 consumes this).
  app.get("/health", (c) =>
    c.json({
      ok: true,
      workspace: opts.workspaceRoot,
      engines: supervisor.engines,
      defaultEngine: supervisor.defaultEngineId,
      // NOTE (BRO-1627 P20 M1): the workspace LIST is deliberately NOT here —
      // /health is unauthenticated, and the list carries absolute rootPaths (a
      // filesystem-layout recon aid). The list lives behind the bearer gate on
      // GET /workspaces; /health stays a liveness probe (engine-capability only).
    }),
  );

  // Voice channel (BRO-2228). Registered ONLY with a configured secret, so an
  // unconfigured deploy 404s instead of exposing an open intake. Nothing here
  // runs an agent: a caller is on the line and a turn takes 9-30s+.
  if (opts.voiceSecret) {
    // A configured channel with no sink used to answer 200 + "I'll follow up"
    // while storing nothing, because enqueueVoice was optional-chained away.
    // That is a misconfiguration, not a runtime condition, so it fails at BUILD
    // rather than silently per-call. (P20 Strata A, round 1.)
    if (!opts.enqueueVoice) {
      throw new Error(
        "voiceSecret is set but enqueueVoice is not: the voice routes would " +
          "acknowledge requests and discard them. Pass a sink (createVoiceQueue).",
      );
    }
    const enqueueVoice = opts.enqueueVoice;
    const voicePrincipals = opts.voicePrincipals ?? [];
    const voiceDenied = (c: { req: { header: (k: string) => string | undefined } }): boolean =>
      !secretMatches(c.req.header("x-genesis-voice-secret"), opts.voiceSecret ?? "");

    // Who is calling? Unknown is a normal answer, not an error — most callers
    // are strangers and the agent's correct move for them is to take a message.
    app.post("/voice/identify", async (c) => {
      if (voiceDenied(c)) return c.json({ error: "unauthorized" }, 401);
      // A PARSE FAILURE IS NOT AN UNKNOWN CALLER. Collapsing it to `{}` made the
      // two indistinguishable: asString(undefined) returns "" rather than throwing,
      // so callerId became "", resolveCaller said not-known, and a truncated body or
      // a serialization bug on ElevenLabs' side returned a cheerful 200 {known:false}
      // — the same answer a stranger gets. A transport fault would have looked like
      // normal traffic forever.
      //
      // `?? {}` is still right for a literal `null` body, which is VALID json, so
      // .catch() never fires and the dereference below was a 500 on both routes.
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as { callerId?: unknown };
      // SAME validation boundary as /voice/request. Round 1 hardened buildTicket
      // and left this route casting raw JSON, so the two disagreed about what a
      // callerId may be: `42` was a 500 here and a 400 there.
      let callerId: string;
      try {
        callerId = readCallerId(body.callerId);
      } catch (e) {
        if (e instanceof VoiceValidationError) return c.json({ error: e.message }, 400);
        throw e;
      }
      const r = resolveCaller(callerId, voicePrincipals);
      // NO NAME. The header of voice.ts states the invariant this route was
      // breaking: caller id is spoofable, so it is a routing hint and a spoofer
      // must gain nothing UNBOUNDED. Returning `name` handed an attacker who guessed a
      // number both "this number is known to the system" and the account
      // holder's name — information gained, from a claim we never verified.
      // `known` is what the agent needs to choose take-a-message vs
      // offer-follow-up. It is NOT free of disclosure — it confirms that the
      // guessed number is in the configured principal set, which is a real bit an
      // attacker did not have (an earlier version of this comment claimed
      // otherwise and was wrong). It is a single bit the caller already
      // half-asserted by dialing it, and withholding it would make the agent
      // unable to answer at all; a NAME was unbounded new information and is
      // gone. Greeting by name needs a second factor (voice.ts
      // header: "any capability that does NOT have that property ... must not be
      // added here without a second factor"). (P20 Strata A, round 1.)
      // canFollowUp requires BOTH a known principal AND a wired delivery leg.
      // canFollowUp is FALSE, unconditionally, because nothing can deliver. This
      // is the answer the agent uses to decide whether to offer a follow-up at
      // all, so a stale `true` here re-created the impossible promise through the
      // door round 1 left open after gating /voice/request alone.
      return c.json(
        r.kind === "known"
          ? { known: true, canFollowUp: false }
          : { known: false, canFollowUp: false },
      );
    });

    // Queue work and RETURN. When a delivery leg exists the answer goes to the
    // number ON FILE — which is what makes a spoofed caller id useless rather
    // than dangerous. None exists yet, so this records the request and promises
    // nothing; the ticket still carries its deliverTo for the future consumer.
    app.post("/voice/request", async (c) => {
      if (voiceDenied(c)) return c.json({ error: "unauthorized" }, 401);
      // Same reasoning as /voice/identify above: a body that did not PARSE is a
      // transport fault, not a request with missing fields. Fixing identify alone
      // would leave the sibling route converting a truncated body into whatever
      // buildTicket makes of `{}`.
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as {
        callerId?: unknown;
        request?: unknown;
        conversationId?: unknown;
      };
      let ticket: VoiceTicket;
      try {
        ticket = buildTicket(body, voicePrincipals, new Date().toISOString(), crypto.randomUUID());
      } catch (e) {
        // A validation message is caller-safe by construction; anything else is
        // internal and must not be read out on a phone call.
        if (e instanceof VoiceValidationError) return c.json({ error: e.message }, 400);
        throw e;
      }
      try {
        await enqueueVoice(ticket);
      } catch (e) {
        console.error(`[genesis] voice enqueue failed: ${e instanceof Error ? e.message : e}`);
        return c.json({ error: "could not record the request; please try again" }, 503);
      }
      return c.json({
        ticketId: ticket.id,
        // The agent reads this to the caller, so it must not promise delivery we
        // cannot make. TWO ways that promise can be false, and only the first was
        // handled: an unrecognized number has nowhere to follow up TO, and — the
        // one that shipped — no delivery leg exists to follow up WITH. The work is
        // still QUEUED; only the promise is withheld. This becomes a real value
        // again in the same change that adds the consumer. (BRO-2228 scope item 4,
        // blocked on #107.)
        followUp: "none",
      });
    });
  }

  // Walkie — the operator's pending decisions (BRO-2387). Registered ONLY with a
  // configured secret, same rule and same reason as the voice channel above.
  //
  // REACHABILITY, corrected. An earlier version of this comment said /walkie/*
  // is not internet-reachable because the Funnel publishes only the /voice
  // prefix. That is what server.ts:100-103 claims, and it is contradicted by the
  // shipped instruction: integrations/elevenlabs/README.md:47-49 and
  // scripts/elevenlabs-provision.sh:31-32 both say to FUNNEL THE ROOT, because
  // --set-path strips the prefix. Assume this surface IS reachable from the
  // public internet, and treat the header check below as the only thing between
  // an anonymous caller and the operator's pending decisions. (BRO-2412.)
  //
  // TRANSPORT NOTE, because it constrains the client and must not be discovered
  // later: authorization is a REQUEST HEADER. `EventSource` cannot set headers —
  // its EventSourceInit has exactly one member, withCredentials — so a browser
  // client reads these with `fetch`, not EventSource. That is a deliberate cost.
  // The alternative is a credential in the query string, which this server's
  // shared `unauthorized()` helper does accept, and which would land the secret
  // in access logs, Referer headers and browser history. Paying a little client
  // complexity to keep a credential out of a URL is the right trade.
  if (opts.walkieSecret) {
    // Same failure this exact shape already shipped once for voice: a configured
    // surface whose sink was optional-chained away answered 200 and stored
    // nothing. A misconfiguration, not a runtime condition — so it fails at
    // BUILD.
    if (!opts.askLog) {
      throw new Error(
        "walkieSecret is set but askLog is not: the walkie routes would " +
          "acknowledge answers and discard them. Pass a store (createAskLog).",
      );
    }
    if (!opts.askLogDir) {
      throw new Error(
        "walkieSecret is set but askLogDir is not: GET /walkie/asks would have " +
          "nothing to read. Pass the same directory createAskLog was given.",
      );
    }
    const askLog = opts.askLog;
    const askLogDir = opts.askLogDir;
    // NOT the shared unauthorized(): that helper opens with
    // `if (!opts.token) return false`, so an unset token authorizes everyone,
    // and it accepts the credential from the query string. Neither is acceptable
    // for a surface that lists what an operator has been asked to decide.
    // A decision, not a document. Generous enough for a free-text answer with
    // reasoning; far below anything that makes the journal expensive to re-read.
    const MAX_ANSWER_CHARS = 4096;
    // Generous multiple of the answer cap: the body carries an id and JSON
    // framing too, and this is a cheap pre-filter rather than the real bound.
    const MAX_BODY_BYTES = 64 * 1024;
    const walkieDenied = (c: { req: { header: (k: string) => string | undefined } }): boolean =>
      !secretMatches(c.req.header("x-genesis-walkie-secret"), opts.walkieSecret ?? "");

    // What is waiting on a person. A plain JSON read — the client renders from
    // this. GET /walkie/stream is a later addition on top, not a prerequisite:
    // a client that can poll this can render, and a streaming endpoint carries
    // hazards a read verb does not.
    app.get("/walkie/asks", (c) => {
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);
      const threadId = c.req.query("thread");
      const includeAnswered = c.req.query("answered") === "1";
      const { entries, degraded } = readAsks(askLogDir, {
        ...(threadId ? { threadId } : {}),
        includeAnswered,
      });
      // BOUNDED, like /admin/voice/queue. Both journals are append-only and
      // nothing compacts them, so an unbounded response grows without limit —
      // measured at 16.2 MB for 100k asks, against the sibling route's 50 over
      // the same record count. Oldest first, so the cap keeps the longest-waiting
      // questions rather than an arbitrary window. (P20 MAJOR.)
      const rawLimit = Number(c.req.query("limit"));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const page = entries.slice(0, limit);
      const truncated = entries.length > page.length;
      // `degraded` travels rather than being swallowed: a read that could not see
      // a file must not look like a repo with nothing pending.
      // `total` and `truncated` travel so a client can tell "nothing pending" from
      // "the first 50 of 4000" — the same reason `degraded` travels.
      return c.json({
        asks: page,
        total: entries.length,
        ...(truncated ? { truncated: true } : {}),
        ...(degraded ? { degraded } : {}),
      });
    });

    // The decision coming back.
    app.post("/walkie/answer", async (c) => {
      if (walkieDenied(c)) return c.json({ error: "unauthorized" }, 401);
      // BEFORE parsing. `c.req.json()` buffers the entire body, and there is no
      // body-size limit anywhere in this server (`app.use` appears zero times),
      // so an authenticated caller could spend our RSS on a request that was
      // going to 400 anyway. voice.ts:98-105 names this same bug as one it
      // already fixed: "an authenticated webhook could send a 100 MB
      // conversationId and have it buffered and appended verbatim". Declared
      // length is advisory — a chunked body carries none — so the parsed answer
      // is still length-checked below; this only refuses the obvious case
      // cheaply. (P20 MAJOR.)
      const declared = Number(c.req.header("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return c.json({ error: "body too large" }, 413);
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const body = (raw ?? {}) as { id?: unknown; answer?: unknown };
      // A parse failure is not an empty answer, and an empty answer is not a
      // decision. Both are 400s with distinct messages — collapsing them is how
      // /voice/identify once made a transport fault look like normal traffic.
      if (typeof body.id !== "string" || !body.id) {
        return c.json({ error: "id must be a non-empty string" }, 400);
      }
      if (typeof body.answer !== "string" || !body.answer) {
        return c.json({ error: "answer must be a non-empty string" }, 400);
      }
      // CAPPED. There is no body-size limit anywhere in this server (`app.use`
      // appears zero times), so an unbounded answer is appended verbatim to a
      // journal every later request re-reads: a 50 MB answer returned 200 in
      // 90 ms and left every subsequent GET and POST re-parsing 50 MB. An answer
      // is a decision, not a document. (P20 MAJOR.)
      if (body.answer.length > MAX_ANSWER_CHARS) {
        return c.json({ error: `answer must be at most ${MAX_ANSWER_CHARS} characters` }, 413);
      }
      // Answering an id that is not in the log is a 404, not a silent accept:
      // otherwise a typo'd id is written to answers.jsonl forever, matching
      // nothing, and the operator believes they answered.
      const known = readAsks(askLogDir, { includeAnswered: true });
      // A DEGRADED READ IS NOT AN ABSENT ASK. Dropping `degraded` here collapsed
      // an unreadable asks.jsonl to an empty list, so every answer to a real
      // pending ask 404'd "no such ask" — telling the operator their question
      // does not exist when the truth is that the log could not be opened. The
      // GET route propagates this deliberately; the POST route must not
      // contradict it. (P20 MAJOR.)
      if (known.degraded) {
        console.error("[walkie] ask log degraded, refusing to answer:", known.degraded);
        return c.json({ error: "could not read the ask log; please try again" }, 503);
      }
      if (!known.entries.some((a) => a.id === body.id)) {
        return c.json({ error: "no such ask" }, 404);
      }
      try {
        askLog.answer({
          id: body.id,
          answer: body.answer,
          answeredAt: new Date().toISOString(),
        });
      } catch (e) {
        // The ask log's failure policy is the voice queue's: propagate. An answer
        // the operator was told was recorded, which then vanished, is worse than
        // a visible failure they can retry.
        console.error("[walkie] could not record answer:", e);
        return c.json({ error: "could not record the answer; please try again" }, 503);
      }
      // Answering twice is a no-op by construction — readAsks keys answers by id
      // in a Map, so the second write overwrites rather than double-counting.
      return c.json({ recorded: true });
    });
  }

  // Operator view of the voice queue (BRO-2284). Until this existed the only way
  // to see a failed delivery was to ssh in and read a journal, which means a
  // closed 24h service window — the failure most likely to happen and least
  // likely to be noticed — was effectively invisible.
  //
  // Same bearer gate as /threads, and see voiceQueueDir above for why the path is
  // NOT under /voice.
  //
  // FAILS CLOSED, unlike every other route here. `unauthorized()` returns false
  // when no token is configured — a deliberate convenience for the local/dev
  // case — and this process binds 0.0.0.0, so on a tokenless deploy anyone who
  // can reach the port reads callers' phone numbers and request text without
  // ever passing the BFF. Reusing that helper for a route carrying PII would
  // inherit a fail-open default I have no business inheriting, so the route is
  // NOT REGISTERED at all without a token, and the panel self-hides. Set
  // GENESIS_TOKEN to turn it on. (P20 round 1, BLOCKER.)
  if (opts.voiceQueueDir && opts.token) {
    const voiceQueueDir = opts.voiceQueueDir;
    const token = opts.token;
    app.get("/admin/voice/queue", async (c) => {
      // HEADER ONLY. The shared helper also accepts ?token=…, and copying that
      // here put a live secret somewhere it gets written down: access logs,
      // proxy logs, browser history, referrers. Tolerable for a thread list;
      // not for the endpoint that serves callers' phone numbers. Compared
      // explicitly rather than through unauthorized() so an absent token can
      // never mean "allow". (P20 round 2, BLOCKER.)
      const auth = c.req.header("authorization");
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!bearer || bearer !== token) return c.json({ error: "unauthorized" }, 401);
      const { entries: all, degraded } = readQueueStatus(voiceQueueDir);
      // Bounded. Both journals are append-only and never compacted, so an
      // unbounded response would ship an ever-growing PII history to render at
      // most a dozen rows.
      const rawLimit = Number(c.req.query("limit"));
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const counts: Record<string, number> = {};
      for (const e of all) counts[e.status] = (counts[e.status] ?? 0) + 1;
      return c.json({
        entries: all.slice(0, limit),
        counts,
        total: all.length,
        // Present only when a journal could not be read — the client shows it
        // rather than rendering a confidently wrong "everything is pending".
        ...(degraded ? { degraded } : {}),
      });
    });
  }

  // Thread session control (BRO-1493): reset (fresh context) / interrupt /
  // status. Slash commands map here, never into the agent TUI.
  app.post("/control", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      threadId?: string;
      action?: string;
      title?: string;
    };
    const threadId = body.threadId;
    if (!threadId) return c.json({ error: "threadId required" }, 400);
    switch (body.action) {
      case "reset":
        return c.json(await supervisor.reset(threadId));
      case "interrupt":
        return c.json(await supervisor.interrupt(threadId));
      case "status":
        return c.json(await supervisor.status(threadId));
      // Session management (BRO-1592) — archive/rename ride /control so the
      // existing /api/control BFF forwards them verbatim (no new BFF family).
      case "archive":
        return c.json(await supervisor.archiveThread(threadId, true));
      case "unarchive":
        return c.json(await supervisor.archiveThread(threadId, false));
      case "rename":
        // Validate at the boundary — body is only type-cast, so a non-string
        // title (e.g. {title: 1}) would otherwise reach setTitle().trim() and throw.
        if (typeof body.title !== "string") return c.json({ error: "title must be a string" }, 400);
        return c.json(await supervisor.setTitle(threadId, body.title));
      default:
        return c.json({ error: `unknown action: ${body.action ?? "(none)"}` }, 400);
    }
  });

  // Thread LIST for the PWA drawer (BRO-1567). Same bearer gate as the rest —
  // it exposes thread metadata + last-turn previews. (Hono matches the static
  // `/threads` ahead of the `/threads/:id` param route regardless of order, so
  // the two never collide.)
  app.get("/threads", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ threads: await supervisor.listThreads() });
  });

  // Selectable workspaces (BRO-1627) for the per-thread workspace picker. Same
  // bearer gate; the client offers these as the "which repo does this thread run
  // in" choice (bound sticky on the thread's first turn).
  app.get("/workspaces", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      workspaces: await supervisor.listWorkspaces(),
      defaultWorkspace: supervisor.defaultWorkspaceId,
    });
  });

  // Re-read the workspace registry without restarting (BRO-2230). Tenant
  // workspaces are provisioned out of band as root, so their manifests land on
  // disk without passing through this process; without this the api serves a
  // boot-time snapshot and the bot refuses every newly approved tenant.
  //
  // Behind the same bearer gate as the list it refreshes: an unauthenticated
  // reload is a cheap way to make the api re-scan a directory repeatedly.
  app.post("/workspaces/refresh", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    await supervisor.reloadWorkspaces();
    const workspaces = await supervisor.listWorkspaces();
    return c.json({ ok: true, count: workspaces.length, ids: workspaces.map((w) => w.id) });
  });

  // Discover→pick provisioning (BRO-1629). Git repos under the allow-root not yet
  // registered — the "Add project" candidates. Same bearer gate. No rootPath leaves
  // the server (only the dir name + the id it would register as).
  app.get("/workspaces/available", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const registered = new Set((await supervisor.listWorkspaces()).map((w) => w.id));
    return c.json({ available: availableWorkspaces(opts.projectsRoot, registered) });
  });

  // Filesystem navigator for the add-by-path picker (BRO-1673). Lists the immediate
  // subdirectories of a directory under the add-roots (pathAddRoots(), default $HOME),
  // so the owner can browse to a folder and register it instead of typing a path.
  // OWNER-ONLY at the BFF (it surfaces absolute paths — same trust model as add-by-path
  // BRO-1663); the bearer gate applies here. The engine enforces the HARD realpath
  // sandbox — a path outside the roots / a symlink escape is a safe 400, never echoing
  // an unexpected fs path.
  app.get("/workspaces/browse", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    try {
      return c.json(browseForAdd(c.req.query("path"), pathAddRoots()));
    } catch (e) {
      if (e instanceof WorkspaceValidationError) return c.json({ error: e.message }, 400);
      console.error(`[genesis] browse failed: ${e instanceof Error ? e.stack : e}`);
      return c.json({ error: "could not browse the filesystem" }, 500);
    }
  });

  // Register a workspace at RUNTIME (BRO-1629) — no restart. Two safe add shapes,
  // both keeping the filesystem-path authority ON THE SERVER (the client never names
  // a path): `{pick}` = a directory NAME from /available (discover→pick, slice 3);
  // `{gitUrl}` = a public git URL the server clones into the allow-root then registers
  // (add-by-git-URL, slice 5). A body with `gitUrl` takes the clone path; else pick.
  app.post("/workspaces", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      pick?: unknown;
      gitUrl?: unknown;
      path?: unknown;
    };
    try {
      const taken = new Set((await supervisor.listWorkspaces()).map((w) => w.id));
      // Three add shapes: `{path}` = an owner-supplied absolute path (BRO-1663,
      // owner-gated at the BFF) → sandboxed to the add-roots; `{gitUrl}` = clone a
      // public repo into the allow-root; `{pick}` = a discovered dir name.
      const ws =
        body.path !== undefined
          ? resolvePathAdd(body.path, pathAddRoots(), taken)
          : body.gitUrl !== undefined
            ? await provisionFromGitUrl(opts.projectsRoot, body.gitUrl, taken)
            : resolvePick(opts.projectsRoot, body.pick, taken);
      const saved = await supervisor.registerWorkspace(ws);
      return c.json({ id: saved.id, name: saved.name, isGitRepo: saved.isGitRepo }, 201);
    } catch (e) {
      // A validation error (bad pick) is safe to echo → 400. Anything else is
      // internal (FS EACCES/ENOSPC with an absolute path) → log server-side +
      // return a GENERIC message, never leaking the filesystem layout (P20 SF2).
      if (e instanceof WorkspaceValidationError) return c.json({ error: e.message }, 400);
      console.error(`[genesis] register workspace failed: ${e instanceof Error ? e.stack : e}`);
      return c.json({ error: "could not register workspace" }, 500);
    }
  });

  // De-register a workspace (BRO-1629). Never deletes the underlying repo — just
  // drops the manifest. The default is protected (removeWorkspace → false → 400);
  // a malformed id is rejected downstream (fileFor) → 400, not a 500 (P20 N1).
  app.delete("/workspaces/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    try {
      const ok = await supervisor.removeWorkspace(c.req.param("id"));
      return ok ? c.json({ ok }) : c.json({ error: "cannot remove the default workspace" }, 400);
    } catch {
      return c.json({ error: "invalid workspace id" }, 400);
    }
  });

  // Read-only workspace filesystem browser (BRO-1666 Slice 1). Two GETs on a
  // workspace, path-SANDBOXED under its server-only rootPath (realpath boundary,
  // mirroring BRO-1663). Same bearer gate as /threads. The client only ever sends a
  // RELATIVE `?path=`; the absolute rootPath NEVER leaves the engine (only relative
  // paths + file contents come back). An unknown workspace → 404; a bad/unsafe path
  // → a safe 400 (never echoing a filesystem path); any other fs error → generic 500.
  const fsErrorResponse = (c: Context, e: unknown, what: string) => {
    if (e instanceof WorkspaceFsError) return c.json({ error: e.message }, e.status);
    console.error(`[genesis] ${what} failed: ${e instanceof Error ? e.stack : e}`);
    return c.json({ error: `could not ${what}` }, 500);
  };

  app.get("/workspaces/:id/files", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      return c.json(listWorkspaceDir(root, c.req.query("path")));
    } catch (e) {
      return fsErrorResponse(c, e, "list directory");
    }
  });

  app.get("/workspaces/:id/file", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      return c.json(readWorkspaceFile(root, c.req.query("path")));
    } catch (e) {
      return fsErrorResponse(c, e, "read file");
    }
  });

  // RAW file bytes (BRO-1667) — serves images/pdf/html inline for the rich viewer.
  // Same bearer gate + path sandbox as /file; the Content-Type is derived from the
  // NAME (never sniffed) and paired with `nosniff` + a strict CSP + `sandbox`, so a
  // mislabeled or HTML/SVG file can't execute if loaded as a top-level document. Size-
  // capped (413). The absolute rootPath never leaves — only the bytes + a safe type.
  app.get("/workspaces/:id/file/raw", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      const { bytes, contentType, size } = readWorkspaceFileRaw(root, c.req.query("path"));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(size),
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
          "content-disposition": "inline",
          "cache-control": "no-store",
        },
      });
    } catch (e) {
      return fsErrorResponse(c, e, "read file");
    }
  });

  // Read-only workspace git browser (BRO-1666 Slice 2) — the Changes tab. Same
  // sandbox posture as the fs routes: rootPath resolved server-side, never returned;
  // git runs read-only via the workspace-git module; the diff `path` is validated +
  // passed only as a pathspec. Same bearer gate; unknown workspace → 404.
  app.get("/workspaces/:id/git/status", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      return c.json(await gitStatus(root));
    } catch (e) {
      return fsErrorResponse(c, e, "read git status");
    }
  });

  app.get("/workspaces/:id/git/diff", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      const cachedQ = c.req.query("cached");
      const cached = cachedQ === "1" || cachedQ === "true";
      return c.json(await gitDiff(root, c.req.query("path"), { cached }));
    } catch (e) {
      return fsErrorResponse(c, e, "compute diff");
    }
  });

  // Commit & Push (BRO-1666 Slice 3) — the only WRITE op. OWNER-ONLY, enforced at
  // the BFF (the agent principal is refused, like BRO-1663 add-by-path); this engine
  // route keeps the standard bearer gate. Fixed argv in gitCommit; the message is the
  // only client input (a single -m arg). unknown workspace → 404, bad input → safe 400.
  app.post("/workspaces/:id/git/commit", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; push?: unknown };
    try {
      return c.json(await gitCommit(root, { message: body.message, push: body.push === true }));
    } catch (e) {
      return fsErrorResponse(c, e, "commit");
    }
  });

  // Read-only CI status (BRO-1669 Slice 4a) — the Checks tab. Shells `gh` read-only
  // (fixed argv; the branch is derived server-side, never client input), confined to a
  // repo root, and degrades gracefully (non-GitHub / unauthenticated → available:false).
  // Same bearer gate; unknown workspace → 404.
  app.get("/workspaces/:id/checks", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const root = await supervisor.resolveWorkspaceRoot(c.req.param("id"));
    if (!root) return c.json({ error: "unknown workspace" }, 404);
    try {
      return c.json(await workspaceChecks(root));
    } catch (e) {
      return fsErrorResponse(c, e, "read checks");
    }
  });

  app.get("/threads/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ turns: await supervisor.history(c.req.param("id")) });
  });

  // Hard-delete a thread + its transcript (BRO-1592). First DELETE route; the
  // BFF /api/threads/:id grows a matching DELETE handler. Same bearer gate.
  app.delete("/threads/:id", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await supervisor.deleteThread(c.req.param("id")));
  });

  app.post("/message", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: string; text?: string };
    const threadId = body.threadId ?? "local";
    const text = body.text ?? "";
    if (!text.trim()) return c.json({ error: "empty message" }, 400);

    hub.publish(threadId, { kind: "turn", role: "user", text });
    const result = await supervisor.dispatch(threadId, text, (state, event) => {
      hub.publish(threadId, {
        kind: "state",
        phase: state.phase,
        lastText: state.lastText,
        event: event.type,
      });
    });
    hub.publish(threadId, { kind: "turn", role: "agent", text: result.reply, phase: result.phase });
    return c.json({
      reply: result.reply,
      phase: result.phase,
      sessionId: result.session.agentSessionId,
    });
  });

  // Chat SDK channel — speaks the AI SDK UI message stream protocol, so any
  // `useChat`/`DefaultChatTransport` client (or curl) drives Genesis directly.
  // The Hono server IS the channel; no separate frontend.
  const chat = new ChatSdkConnector(() => ({
    messageId: crypto.randomUUID(),
    newTextId: () => crypto.randomUUID(),
    newReasoningId: () => crypto.randomUUID(),
  }));
  // Reject an oversized body before buffering/parsing it (BRO-1706, P20
  // cross-review): the per-attachment caps run POST-parse, so an unbounded JSON body
  // (10 attachments × ~26 MB base64 + overhead) would OOM before they apply. ~256 MB
  // comfortably covers a full attachment set; Content-Length rides normal fetch/undici
  // JSON POSTs (and the BFF forwards it). Absent → we still parse, but the attachment
  // caps then bound what is retained.
  const MAX_CHAT_BODY_BYTES = 256 * 1024 * 1024;
  app.post("/api/chat", async (c) => {
    if (unauthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_CHAT_BODY_BYTES) {
      return c.json({ error: "request body too large" }, 413);
    }
    let incoming: IncomingMessage;
    try {
      incoming = chat.parseIncoming(await c.req.json().catch(() => null));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "bad request" }, 400);
    }
    const events = eventStream(async (emit) => {
      // Tool parts are emitted on transition only (BRO-1607): once when issued
      // (input-available), once when the result fills (output-available/error).
      // Keyed by toolCallId → last-emitted state, so each transition fires once.
      const emittedTool = new Map<string, string>();
      const result = await supervisor.dispatch(
        incoming.threadId,
        incoming.text,
        (state) => {
          // reasoning note rides the phase events; the connector emits it once as
          // AI-SDK reasoning parts before the answer text (BRO-1574). The prose is
          // redacted under subscription auth, so this is a token-based indicator.
          emit({
            kind: "phase",
            phase: state.phase,
            text: state.lastText,
            reasoning: reasoningNote(state.reasoned, state.thinkingTokens, state.reasoning),
          });
          // Surface new/advanced tool parts as dynamic-tool stream parts (BRO-1607)
          // — the connector closes the open text part first, so tools render in
          // place between the text blocks that bracket them.
          for (const p of state.parts ?? []) {
            if (p.type !== "tool") continue;
            if (emittedTool.get(p.toolCallId) !== p.state) {
              emittedTool.set(p.toolCallId, p.state);
              emit({ kind: "tool", part: p });
            }
          }
        },
        {
          model: incoming.model,
          effort: incoming.effort,
          engine: incoming.engine,
          workspaceId: incoming.workspaceId,
          channelQualified: incoming.channelQualified,
          worktree: incoming.worktree,
          // Multimodal attachments (BRO-1706) → runner materializes into the cwd.
          attachments: incoming.attachments,
        },
      );
      emit({
        kind: "reply",
        phase: result.phase,
        text: result.reply,
        usage: result.usage,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });
    });
    return chat.encodeStream(events);
  });

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const threadId = c.req.query("thread") ?? "local";
      let unsub: () => void = () => {};
      return {
        onOpen(_e, ws) {
          unsub = hub.subscribe(threadId, (msg) => ws.send(JSON.stringify(msg)));
          ws.send(JSON.stringify({ kind: "ready", threadId }));
        },
        onClose() {
          unsub();
        },
        onError() {
          unsub(); // disconnect without a clean close must still reclaim (F17)
        },
      };
    }),
  );

  return { app, websocket, supervisor, hub };
}
