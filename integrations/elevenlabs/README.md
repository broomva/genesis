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

```bash
ELEVENLABS_API_KEY=...           \
GENESIS_PUBLIC_URL=https://...   \
GENESIS_VOICE_SECRET=...         \
  scripts/elevenlabs-provision.sh          # --dry-run stops before any write
```

Then commit the `id` values it writes back, or the next run creates a second copy
of every tool and agent.

`GENESIS_VOICE_SECRET` must be **the same value Genesis is running with**. If they
differ, every tool call returns 401 and the agent will sound like it is working
while recording nothing.

`GENESIS_PUBLIC_URL` is a base URL with no path and no trailing slash. A Tailscale
funnel is the easy option — but do **not** use `--set-path`: it strips the prefix,
so ElevenLabs calls `/voice/identify` and Genesis never sees that path. Funnel the
root.

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
