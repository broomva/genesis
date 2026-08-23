#!/usr/bin/env bash
# Provision the Genesis Voice agent on ElevenLabs from integrations/elevenlabs/
# (BRO-2257 / BRO-2228).
#
# WHY A SCRIPT AND NOT `elevenlabs agents push` DIRECTLY:
#   1. Committed configs carry ${GENESIS_PUBLIC_URL}/${GENESIS_VOICE_SECRET}
#      placeholders — a literal secret in a tracked file is a committed
#      credential. Substitution happens into a temp copy deleted on exit.
#   2. The agent needs tool IDs that do not exist until the tools are pushed.
#   3. IDs are written back so a second run UPDATES instead of duplicating.
set -uo pipefail

# Secrets pass through this script. Under `bash -x` every substitution would be
# echoed verbatim into the terminal or a CI log, so tracing is turned OFF here
# regardless of how we were invoked. This is deliberate and not a convenience.
set +x

usage () {
  cat >&2 <<USAGE
usage: scripts/elevenlabs-provision.sh [--dry-run]

  --dry-run   validate and substitute, push nothing.

authentication (either one):
  elevenlabs auth login   stores a key the CLI reads (preferred)
  ELEVENLABS_API_KEY      set in the environment instead

required environment:
  GENESIS_PUBLIC_URL    base URL ElevenLabs reaches Genesis on. Scheme required,
                        no path, no trailing slash — /voice/* is appended.
                        A Tailscale funnel works; do NOT use --set-path, it
                        strips the prefix and /voice/* stops resolving.
  GENESIS_VOICE_SECRET  must EQUAL the value Genesis is running with, or every
                        tool call returns 401 while sounding like success.
USAGE
}

# Fail CLOSED on anything unrecognized: silently treating `--dry-rnu` as live
# mode would push to a real workspace while the operator believed nothing moved.
DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC="$REPO_ROOT/integrations/elevenlabs"
CLI="@elevenlabs/cli@${ELEVENLABS_CLI_VERSION:-0.5.6}"

missing=()
[ -n "${GENESIS_PUBLIC_URL:-}" ]   || missing+=("GENESIS_PUBLIC_URL")
[ -n "${GENESIS_VOICE_SECRET:-}" ] || missing+=("GENESIS_VOICE_SECRET")
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ missing required environment: ${missing[*]}" >&2; echo >&2; usage; exit 2
fi

# ElevenLabs auth: EITHER the env var OR the credential `elevenlabs auth login`
# stores. Requiring the env var was wrong — it is not the documented way to
# authenticate this CLI, so an operator who followed the CLI's own instructions
# was told they had configured nothing. Never read the key file here; the CLI
# owns that, and copying it into this process only widens where it can leak.
if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  # Match the OUTPUT, not the exit code: `auth whoami` prints "Not logged in" and
  # exits 0, exactly like the push commands report per-item failures and exit 0.
  # Gating on `if whoami >/dev/null` looked right and could never fail.
  who=$( { command -v elevenlabs >/dev/null 2>&1 && elevenlabs auth whoami; } 2>&1 )
  [ -n "$who" ] || who=$(npx -y "$CLI" auth whoami 2>&1)
  if printf '%s' "$who" | grep -qi "logged in:"; then
    echo "▶ using the credential stored by \`elevenlabs auth login\`"
  else
    echo "✗ not authenticated to ElevenLabs." >&2
    echo "  run \`elevenlabs auth login\`, or set ELEVENLABS_API_KEY." >&2
    echo >&2; usage; exit 2
  fi
fi

# Scheme required, and NO path component — the README promises /voice/* is
# appended to a bare origin, and https://host/prefix would silently provision
# tools pointing at /prefix/voice/* which Genesis does not serve.
python3 - "$GENESIS_PUBLIC_URL" <<'PY' || exit 2
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
if u.scheme not in ("http", "https"):
    sys.exit(f"✗ GENESIS_PUBLIC_URL needs an http(s) scheme (got: {sys.argv[1]})")
if not u.netloc:
    sys.exit(f"✗ GENESIS_PUBLIC_URL has no host (got: {sys.argv[1]})")
if u.path not in ("", "/"):
    sys.exit(f"✗ GENESIS_PUBLIC_URL must be a bare origin with no path; /voice/* is\n"
             f"  appended to it. Got path {u.path!r}. Genesis serves /voice/* at the root.")
if sys.argv[1].endswith("/"):
    sys.exit(f"✗ GENESIS_PUBLIC_URL must not end in '/' (got: {sys.argv[1]})")
if u.query or u.fragment:
    sys.exit("✗ GENESIS_PUBLIC_URL must not carry a query or fragment")
if u.username or u.password or "@" in u.netloc:
    # Credentials in the URL would be embedded in every tool config AND echoed by
    # the substitution log line below.
    sys.exit("✗ GENESIS_PUBLIC_URL must not embed credentials (user:pass@host)")
try:
    port = u.port          # raises ValueError on a textual or out-of-range port
except ValueError:
    sys.exit("✗ GENESIS_PUBLIC_URL has an invalid port")
if port is not None and not (0 < port < 65536):
    sys.exit("✗ GENESIS_PUBLIC_URL has an invalid port")
PY

# `set -e` is not in force (a failed CLI call must be reported, not abort mid-push
# leaving state), so every command whose failure would be catastrophic is checked
# explicitly. This one most of all: an empty WORK makes the copy below target `/`
# and makes substitution glob the CALLER'S cwd — which, run from
# integrations/elevenlabs, writes the live secret into tracked config files.
WORK=$(mktemp -d /tmp/el-provision.XXXXXX) || { echo "✗ could not create a temp dir" >&2; exit 1; }
# CANONICALIZE before matching: a prefix check alone accepts
# /tmp/el-provision.fake/../<repo>, which normalizes back into the working tree —
# and `rm -rf "$WORK"` would then run on it.
WORK=$(cd "$WORK" 2>/dev/null && pwd -P) || { echo "✗ temp dir is not usable" >&2; exit 1; }
case "$WORK" in
  /tmp/el-provision.*|/private/tmp/el-provision.*) ;;
  *) echo "✗ refusing to continue: unexpected temp dir '$WORK'" >&2; exit 1 ;;
esac
[ -d "$WORK" ] || { echo "✗ temp dir '$WORK' is not a directory" >&2; exit 1; }
# INT/TERM as well as EXIT: a Ctrl-C mid-push must not leave a world-readable
# temp directory containing the shared secret.
cleanup () { rm -rf "$WORK"; }
# EXIT removes the staging dir; INT/TERM must ALSO exit, or Ctrl-C would run the
# handler and then carry on into the pushes with the staging dir already gone.
trap cleanup EXIT
trap 'cleanup; echo; echo "✗ interrupted" >&2; exit 130' INT TERM
cp -R "$SRC/." "$WORK/" || { echo "✗ could not stage configs into $WORK" >&2; exit 1; }

echo "▶ substituting into a temp copy"
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys, glob
work = sys.argv[1]
url, secret = os.environ["GENESIS_PUBLIC_URL"], os.environ["GENESIS_VOICE_SECRET"]
# json.dumps then strip the quotes: a secret containing " or \ would otherwise
# produce invalid JSON, rejecting a perfectly legal credential.
esc = lambda v: json.dumps(v)[1:-1]
for f in glob.glob(os.path.join(work, "tool_configs", "*.json")):
    raw = open(f, encoding="utf-8").read()
    raw = raw.replace("${GENESIS_PUBLIC_URL}", esc(url)).replace("${GENESIS_VOICE_SECRET}", esc(secret))
    if "${" in raw:
        sys.exit(f"✗ unsubstituted placeholder left in {f}")
    open(f, "w", encoding="utf-8").write(raw)
    cfg = json.loads(raw)   # parses => the substitution did not corrupt the JSON
    print(f"  {cfg['name']} -> {cfg['api_schema']['url']}")
PY

# GENESIS_VOICE_SECRET is already baked into the temp configs; the CLI never
# needs it. Dropping it from the child environment keeps it out of `ps eww` for
# the whole life of a slow push. ELEVENLABS_API_KEY must pass through.
el () { env -u GENESIS_VOICE_SECRET npx -y "$CLI" "$@"; }

# The pinned CLI catches per-item API failures, prints them, and still exits 0
# (see its tools/commands/impl.ts and agents/commands/push-impl.ts). So an exit
# code alone would let a failed update reach the final success line. Run the push,
# show its output, and treat its own error markers as failure.
el_push () {
  local label="$1"; shift
  local out rc
  out=$( { el "$@"; rc=$?; } 2>&1; echo "__RC__$rc" )
  rc=${out##*__RC__}
  out=${out%__RC__*}
  printf '%s' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "✗ $label failed (exit $rc)" >&2; return 1
  fi
  # The CLI reports failure several ways and none of them change its exit code:
  # "Error processing X", a leading-space "✗ Error pushing branch", and
  # "Warning: Config file not found" (which silently pushes FEWER items than
  # intended). Match them with leading whitespace allowed.
  if printf '%s' "$out" | grep -qiE "^[[:space:]]*(error|✗|warning:)|error (creating|processing|reading|updating|pushing)|not configured|not found|skipping"; then
    echo "✗ $label reported an error while still exiting 0 — treating as failure" >&2
    return 1
  fi
  return 0
}

# RECOVERABILITY. The CLI records the items that DID succeed and still exits 0
# when a sibling failed. Exiting immediately on a detected error therefore
# destroyed the staging dir holding the only record of tools that were really
# created, and the retry made duplicates. So: push, then ALWAYS try to record
# whatever valid ids came back, and only then fail.
echo "▶ pushing tools"
( cd "$WORK" && el_push "tools push" tools push ${DRY_RUN} )
TOOLS_RC=$?

if [ -n "$DRY_RUN" ]; then
  [ "$TOOLS_RC" -eq 0 ] || exit 1
  echo "▶ dry run: stopping before the agent push; nothing was created"
  exit 0
fi

# Record BEFORE deciding to abort, so a partial success is not thrown away.
if [ "$TOOLS_RC" -ne 0 ]; then
  echo "▶ tools push reported a failure — salvaging any ids that were assigned"
  python3 - "$WORK" "$SRC" tools.json tools <<'SALVAGE'
import json, os, sys
work, src, name, key = sys.argv[1:5]
try:
    pushed = {e["name"]: e.get("id", "") for e in json.load(open(os.path.join(work, name), encoding="utf-8"))[key]}
except Exception as exc:                       # staging unreadable: nothing to salvage
    sys.exit(0)
p = os.path.join(src, name)
doc = json.load(open(p, encoding="utf-8"))
changed = False
for e in doc[key]:
    new = pushed.get(e["name"], "")
    if new and e.get("id") != new:
        print(f"  salvaged {e['name']} id -> {new}")
        e["id"] = new; changed = True
if changed:
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write("\n")
    print("  ✔ COMMIT these ids — they name tools that really exist remotely, and")
    print("    without them the next run creates duplicates.")
else:
    print("  (no ids were assigned; nothing was created remotely)")
SALVAGE
  echo "✗ aborting after a failed tools push" >&2
  exit 1
fi

# VALIDATE BEFORE PERSISTING. The distinctness check used to run after these ids
# were already written into tracked tools.json, so a bad push left corrupted state
# in the repo that the operator was then told to commit.
echo "▶ validating tool ids"
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
tools = json.load(open(os.path.join(sys.argv[1], "tools.json"), encoding="utf-8"))["tools"]
ids = [t.get("id") for t in tools]
if not tools:
    # all([]) is True, so an empty list used to sail through and then push an
    # agent wired to no tools at all.
    sys.exit("✗ tools.json lists no tools; nothing to wire an agent to")
if not all(ids):
    sys.exit(f"✗ a tool has no id after push ({ids}); refusing to record or push further")
if len(set(ids)) != len(tools):
    sys.exit(f"✗ tool ids are not distinct ({ids}); refusing to record a state that "
             f"would bind the agent to fewer tools than it needs")
print(f"  {len(ids)} distinct tool id(s)")
PY

# Persist tool IDs NOW, before the agent push can fail. Deferring this until the
# end meant a failed agent push destroyed the temp dir holding the only record of
# freshly created tools, and the retry created a second copy of each.
echo "▶ recording tool ids"
python3 - "$WORK" "$SRC" tools.json tools <<'PY' || exit 1
import json, os, sys
work, src, name, key = sys.argv[1:5]
pushed = {e["name"]: e.get("id", "") for e in json.load(open(os.path.join(work, name), encoding="utf-8"))[key]}
p = os.path.join(src, name)
doc = json.load(open(p, encoding="utf-8"))
changed = False
for e in doc[key]:
    new = pushed.get(e["name"], "")
    if new and e.get("id") != new:
        print(f"  {name}: {e['name']} id -> {new}")
        e["id"] = new; changed = True
if changed:
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write("\n")
    print(f"  ✔ {name} updated — COMMIT THIS even if the agent push below fails,")
    print(f"    or the next run creates duplicate tools.")
PY

echo "▶ wiring tool ids into the agent"
python3 - "$WORK" <<'PY' || exit 1
import json, os, sys
work = sys.argv[1]
tools = json.load(open(os.path.join(work, "tools.json"), encoding="utf-8"))["tools"]
ids = [t.get("id") for t in tools]
if not all(ids):
    sys.exit("✗ a tool has no id after push; refusing to push an agent missing a "
             "tool it depends on")
# Second barrier. The same check runs before persisting; this one guards the
# WORK copy actually being pushed, which is what the agent is bound to.
if len(set(ids)) != len(tools):
    sys.exit(f"✗ tool ids are not distinct ({ids}); the agent would be bound to "
             f"fewer tools than it needs")
agents = json.load(open(os.path.join(work, "agents.json"), encoding="utf-8"))
p = os.path.join(work, agents["agents"][0]["config"])
cfg = json.load(open(p, encoding="utf-8"))
cfg["conversation_config"]["agent"]["prompt"]["tool_ids"] = ids
json.dump(cfg, open(p, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print(f"  tool_ids = {ids}")
PY

echo "▶ pushing agent"
( cd "$WORK" && el_push "agent push" agents push ) || { echo "  (tool ids were already recorded — commit them)" >&2; exit 1; }

echo "▶ recording agent id"
python3 - "$WORK" "$SRC" agents.json agents <<'PY' || exit 1
import json, os, sys
work, src, name, key = sys.argv[1:5]
pushed = {e["name"]: e.get("id", "") for e in json.load(open(os.path.join(work, name), encoding="utf-8"))[key]}
p = os.path.join(src, name)
doc = json.load(open(p, encoding="utf-8"))
changed = False
for e in doc[key]:
    new = pushed.get(e["name"], "")
    if new and e.get("id") != new:
        print(f"  {name}: {e['name']} id -> {new}")
        e["id"] = new; changed = True
if changed:
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write("\n")
PY

echo
echo "✓ provisioned. Commit the id changes in integrations/elevenlabs/*.json."
echo "  The secret existed only in a temp copy, now deleted."
