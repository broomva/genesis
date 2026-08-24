# tenant-skills

Skills seeded into **every** WhatsApp tenant workspace by the provisioner.

Point `GENESIS_TENANT_SKILLS_DIR` at this directory:

```bash
GENESIS_TENANT_SKILLS_DIR=/home/agent/genesis/tenant-skills
```

`scripts/provision-whatsapp-tenants.ts` then copies each skill into
`<workspace>/.claude/skills/<name>/`, **root-owned and `0444`**. The tenant runs
with the skill and can never rewrite it — `allowed-tools:` frontmatter is a real
permission layer, so a tenant-writable `.claude/` would be a privilege
escalation at the default tier. See `packages/core/src/skill-seed.ts`.

## What may live here

Only `.md`, `.txt`, `.json`, `.yaml`/`.yml` are copied — an allowlist, because a
root process must not copy arbitrary trees into a tenant sandbox.

**Nothing here is seeded with an executable bit**, and the allowlist is on the
FILENAME SUFFIX only — so it stops a `.sh` from being copied, but it does not
stop a script stored as `.txt` and run through an interpreter. Treat the rule as
"capability does not ship here", not as a sandbox: a root process copying files
into a tenant is not the layer that constrains what the tenant may execute. That
is `settings.json`.

Anything the agent needs to *run* should exist in the environment the way
`google-chrome` already does. Knowledge is seeded; capability is installed.

Directory names must match `^[a-z0-9][a-z0-9-]{0,63}$`.

## Why this exists at all

A tenant workspace used to contain no `.md` whatsoever, so the agent had no idea
what it was speaking through. It wrote replies for a terminal, and produced an
HTML report the operator had no way to open — not because anything failed, but
because nothing had ever told it the shape of the channel.

The point is a **fertile environment** rather than special-case code paths: tell
the agent what the channel affords and forbids, and let it compose the right
answer itself.
