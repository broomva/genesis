#!/usr/bin/env bash
# Provision the Genesis Voice agent on ElevenLabs from the configs in
# integrations/elevenlabs/ (BRO-2257 / BRO-2228).
#
# WHY A SCRIPT AND NOT `elevenlabs agents push` DIRECTLY. Three things the raw
# CLI will not do for us:
#   1. The committed tool configs carry ${GENESIS_PUBLIC_URL} and
#      ${GENESIS_VOICE_SECRET} placeholders. The shared secret must never be
#      written into a tracked file, so substitution happens into a TEMP copy that
#      is deleted on exit; the repo copy is never mutated with a secret.
#   2. The agent needs the tool IDs, which do not exist until the tools are
#      pushed. This pushes tools first, reads the IDs back, injects them into the
#      agent's prompt.tool_ids, and only then pushes the agent.
#   3. IDs assigned on first push are merged back into the tracked index files so
#      the next run UPDATES instead of creating a second copy of everything.
#
# Usage:
#   ELEVENLABS_API_KEY=... GENESIS_PUBLIC_URL=https://host GENESIS_VOICE_SECRET=... \
#     scripts/elevenlabs-provision.sh [--dry-run]
set -euo pipefail

DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN="--dry-run"

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC="$REPO_ROOT/integrations/elevenlabs"
CLI_VERSION="${ELEVENLABS_CLI_VERSION:-0.5.6}"

missing=()
[ -n "${ELEVENLABS_API_KEY:-}" ]   || missing+=("ELEVENLABS_API_KEY")
[ -n "${GENESIS_PUBLIC_URL:-}" ]   || missing+=("GENESIS_PUBLIC_URL")
[ -n "${GENESIS_VOICE_SECRET:-}" ] || missing+=("GENESIS_VOICE_SECRET")
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ missing required environment: ${missing[*]}" >&2
  echo >&2
  echo "  ELEVENLABS_API_KEY    from https://elevenlabs.io/app/settings/api-keys" >&2
  echo "  GENESIS_PUBLIC_URL    the base URL ElevenLabs can reach Genesis on, no" >&2
  echo "                        trailing slash and no path — /voice/* is appended." >&2
  echo "                        A Tailscale funnel works; do NOT use --set-path," >&2
  echo "                        it strips the prefix and /voice/* stops resolving." >&2
  echo "  GENESIS_VOICE_SECRET  must EQUAL the value Genesis itself is running" >&2
  echo "                        with, or every tool call comes back 401." >&2
  exit 2
fi

case "$GENESIS_PUBLIC_URL" in
  */) echo "✗ GENESIS_PUBLIC_URL must not end in '/' (got: $GENESIS_PUBLIC_URL)" >&2; exit 2 ;;
  http://*|https://*) ;;
  *) echo "✗ GENESIS_PUBLIC_URL must include the scheme (got: $GENESIS_PUBLIC_URL)" >&2; exit 2 ;;
esac

WORK=$(mktemp -d /tmp/el-provision.XXXXXX)
trap 'rm -rf "$WORK"' EXIT   # the substituted copy holds the secret; never persist it
cp -R "$SRC/." "$WORK/"

python3 - "$WORK" <<'PY'
import json, os, sys, glob
work = sys.argv[1]
url, secret = os.environ["GENESIS_PUBLIC_URL"], os.environ["GENESIS_VOICE_SECRET"]
for f in glob.glob(os.path.join(work, "tool_configs", "*.json")):
    raw = open(f, encoding="utf-8").read()
    raw = raw.replace("${GENESIS_PUBLIC_URL}", url).replace("${GENESIS_VOICE_SECRET}", secret)
    if "${" in raw:
        sys.exit(f"unsubstituted placeholder left in {f}")
    open(f, "w", encoding="utf-8").write(raw)
    cfg = json.load(open(f, encoding="utf-8"))
    print(f"  {cfg['name']} -> {cfg['api_schema']['url']}")
PY

echo "▶ pushing tools"
( cd "$WORK" && npx -y "@elevenlabs/cli@${CLI_VERSION}" tools push ${DRY_RUN} )

if [ -n "$DRY_RUN" ]; then
  echo "▶ dry run: stopping before the agent push (tool ids were never assigned)"
  exit 0
fi

echo "▶ wiring tool ids into the agent"
python3 - "$WORK" <<'PY'
import json, os, sys
work = sys.argv[1]
tools = json.load(open(os.path.join(work, "tools.json"), encoding="utf-8"))
ids = [t["id"] for t in tools["tools"] if t.get("id")]
if len(ids) != len(tools["tools"]):
    sys.exit("✗ not every tool has an id after push; refusing to push an agent "
             "that would be missing a tool it depends on")
agents = json.load(open(os.path.join(work, "agents.json"), encoding="utf-8"))
p = os.path.join(work, agents["agents"][0]["config"])
cfg = json.load(open(p, encoding="utf-8"))
cfg["conversation_config"]["agent"]["prompt"]["tool_ids"] = ids
json.dump(cfg, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print(f"  tool_ids = {ids}")
PY

echo "▶ pushing agent"
( cd "$WORK" && npx -y "@elevenlabs/cli@${CLI_VERSION}" agents push )

echo "▶ writing assigned ids back into the tracked index files"
python3 - "$WORK" "$SRC" <<'PY'
import json, os, sys
work, src = sys.argv[1], sys.argv[2]
for name, key in (("tools.json", "tools"), ("agents.json", "agents")):
    pushed = {e["name"]: e.get("id", "") for e in json.load(open(os.path.join(work, name), encoding="utf-8"))[key]}
    p = os.path.join(src, name)
    doc = json.load(open(p, encoding="utf-8"))
    changed = False
    for e in doc[key]:
        new = pushed.get(e["name"], "")
        if new and e.get("id") != new:
            print(f"  {name}: {e['name']} id -> {new}")
            e["id"] = new
            changed = True
    if changed:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
PY

echo
echo "✓ provisioned. Commit the id changes in integrations/elevenlabs/*.json so the"
echo "  next run updates these agents instead of creating duplicates."
echo "  The secret was only ever in a temp copy, now deleted."
