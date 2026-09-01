# ElevenLabs voice agent, as code

The phone side of the Genesis voice channel (BRO-2228). A caller dials a number,
an ElevenLabs agent answers, and it reaches Genesis through two webhook tools.
Everything the vendor needs lives here so the config is reviewable in a diff
rather than clicked into a dashboard and forgotten.

| File | What it is |
|---|---|
| `agents.json` / `tools.json` | Index files. `id` is `""` until first push; the CLI **creates** on an empty id and **updates** on a set one. |
| `agent_configs/genesis-voice.json` | The agent: voice, turn-taking, and the prompt. |
| `tool_configs/genesis-voice-*.json` | The two webhook tools, targeting `/voice/identify` and `/voice/request`. |

## Provision

Authenticate once, the CLI's own way:

```bash
elevenlabs auth login          # stores a key in ~/.elevenlabs/api_key
```

Then:

```bash
GENESIS_PUBLIC_URL=https://...   \
GENESIS_VOICE_SECRET=...         \
  scripts/elevenlabs-provision.sh          # --dry-run stops before any write
```

`ELEVENLABS_API_KEY` in the environment works as an alternative to `auth login`.
The script never reads the stored key itself — the CLI owns it, and copying it
into another process only widens where it can leak.

Note when reading this script or the CLI's output: **this CLI does not use exit
codes.** `auth whoami` prints "Not logged in" and exits 0; `tools push` prints
per-item API errors and exits 0. Every check here matches output text for that
reason, and a gate written as `if elevenlabs auth whoami; then` can never fail.

Then commit the `id` values it writes back, or the next run creates a second copy
of every tool and agent.

`GENESIS_VOICE_SECRET` must be **the same value Genesis is running with**. If they
differ, every tool call returns 401 and the agent will sound like it is working
while recording nothing.

`GENESIS_PUBLIC_URL` is a base URL with no path and no trailing slash.

**Do not funnel the root.** Scope it to `/voice` on a dedicated port — and the
port is not free: Tailscale Funnel listens only on **443, 8443 and 10000**. On
this host 443 and 8443 are already taken, which is why the recipe says 10000.

```sh
tailscale funnel --bg --https=10000 --set-path=/voice http://127.0.0.1:8787/voice
```

Then `GENESIS_PUBLIC_URL=https://<host>.<tailnet>.ts.net:10000`.

**One command, not two.** Since the v2 CLI, `funnel` *is* `serve` with
`AllowFunnel` set — it establishes the mount and publishes it in the same call.
There is no toggle form. `tailscale funnel --help` documents
`funnel <target>` (plus `status` and `reset`) and no on/off form, and the pre-v2
syntax is rejected outright with *"the CLI for
serve and funnel has changed"*.

An earlier revision of this file prescribed two commands: a `serve` line, then a
second line attempting to switch the funnel on. That would have left the mount
tailnet-only — the same "published nothing" failure it was written to fix. The
removed command is described rather than quoted here on purpose: a shipped file
should not carry a copy-pasteable command that does not work, and the guard in
`deployment-claims.test.ts` reads command lines rather than prose precisely
because a command is what an operator acts on.

Confirmed against the host's own state rather than by parsing: `serve
status --json` reports `AllowFunnel` true for `:10000` with a single `/voice`
mount, which is what the one command above produces.

**Why the target repeats `/voice`.** `--set-path=/voice` mounts the handler at
`/voice` and STRIPS that prefix before forwarding — so with a bare
`http://127.0.0.1:8787` target, `/voice/identify` arrives at Genesis as
`/identify` and 404s. Naming `http://127.0.0.1:8787/voice` as the target re-joins
it, and the round trip is `/voice/identify` → `/voice/identify`.

An earlier version of this paragraph got that backwards twice: it concluded from
the stripping that the root had to be funnelled, and a later revision claimed
`--set-path` was not involved at all. `--set-path` is exactly the mechanism; what
was missing was the prefix on the target.

**Why the scope matters**, as consequence rather than preference: funnelling the
root publishes *every* route on that port, including `POST /message`, which
dispatches an agent turn — arbitrary command execution in a workspace. Those
routes are gated by `unauthorized()`, which opens with `if (!opts.token) return
false`, so on a deploy without `GENESIS_TOKEN` they authorize everyone.

**Measured, and re-runnable:** `scripts/funnel-scope-probe.sh <host> [port]`.
Run against the live host 2026-09-01, over public DNS pinned with `--resolve`:

| request | code | bytes | who answered |
|---|---|---|---|
| `POST /voice/identify` | 401 | 24 | Genesis (`{"error":"unauthorized"}`) |
| `POST /voice/request` | 401 | 24 | Genesis |
| `POST /message/__scope_probe__` | 404 | **19** | **tailscaled** — declined at the funnel |
| `POST /control/__scope_probe__` | 404 | **19** | tailscaled — declined |
| `POST /workspaces/refresh/__scope_probe__` | 404 | **19** | tailscaled — declined |
| `POST /walkie/asks/__scope_probe__` | 404 | **19** | tailscaled — declined |

The byte count is the discriminator, not the status: Hono's 404 body is
`404 Not Found` (13 bytes) and tailscaled's Go `http.NotFound` is
`404 page not found` (19 bytes). A 19-byte 404 means the request never reached
Genesis. The script also prints `remote_ip` per row, because MagicDNS resolves
this hostname to the tailnet and a plain `curl` would measure the wrong path
entirely — which has already happened here once.

## Why the prompt is written the way it is

`/voice/request` returns `followUp: "none"` and `/voice/identify` returns
`canFollowUp: false` for **every** caller right now, because nothing drains the
queue yet (BRO-2228 scope item 4). The surface was deliberately built so that a
follow-up cannot be promised — the option to claim one was removed from
`build()` entirely rather than merely switched off.

A prompt can undo all of that with one sentence, from outside the codebase, where
no route test can see it. So `apps/api/src/voice-agent-config.test.ts` asserts the
prompt against known commitment phrasings and fails CI if one appears. If you are
editing the prompt and that test fails, it is not in your way — it is telling you
the agent would promise a caller something the system cannot do.

**Know what that test is and is not.** It is a regression net, not a proof. Three
cross-model review rounds went into widening it, and each round produced a
phrasing that got past the previous one — ending with *"Expect a call from our
team tomorrow"*, which names no actor and uses no future modal, so no regex could
see it. That is not a defect in the patterns; it is what natural language is. CI
can prove the prompt **contains** its safety clauses, and can stop a phrasing we
have already seen from coming back. It cannot prove prose free of contradiction.
The real control is that this prompt lives in a repo and a human reads it in the
diff, which is the reason it is here rather than in a dashboard.

The prompt also refuses to greet by name. `/voice/identify` stopped returning the
principal's name because caller id is spoofable and a name was unbounded
information handed to whoever guessed a number; an agent that greeted by name
from any other source would reopen exactly that leak.

## Testing without a phone number

1. `scripts/voice-smoke.sh` — exercises the Genesis side end to end, no vendor
   account needed. Run this first; if it fails, the phone side cannot work.
2. ElevenLabs' agent-test console invokes the tools without placing a real call,
   so steps 1–3 of provisioning are testable before a number is purchased.
3. A real PSTN call needs a telephony number attached to the agent.

## Residual risk, named

- **Provisioning is not transactional.** The CLI records items that succeed even
  when a sibling fails, and reports both with exit 0. The script detects failure
  from the CLI's own output and salvages any ids that were assigned before
  aborting, so a retry updates rather than duplicates — but it does not reconcile
  against remote state. Truly closing this means listing remote tools and agents
  through the API after each push, which needs a key to build against.
- **`ELEVENLABS_API_KEY` is in the CLI's environment** for the life of a push, and
  visible to the same user in a process listing. That is inherent to invoking the
  vendor CLI. `GENESIS_VOICE_SECRET` is dropped from child environments, since the
  configs already carry it.
- **The queue is best-effort** (no fsync) and nothing drains it yet. Both must be
  addressed by the change that adds the consumer, not before.
