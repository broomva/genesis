#!/usr/bin/env bash
# Timer entrypoint. Prefers the probe from the deployed checkout so it tracks
# whatever is actually running; falls back to the installed copy while the box
# sits on a branch that predates scripts/deploy-probe.sh. Self-heals on return
# to main. Kept as a script rather than an inline ExecStart because the nested
# quoting in a unit file silently produced `exec ""` and a 127 that no journal
# line explained.
set -uo pipefail
P="$HOME/genesis/scripts/deploy-probe.sh"
[ -x "$P" ] || P="$HOME/.local/bin/genesis-deploy-probe.sh"
[ -x "$P" ] || { echo "genesis-deploy-probe: no probe found at either path"; exit 127; }
echo "genesis-deploy-probe: using $P"
exec "$P"
