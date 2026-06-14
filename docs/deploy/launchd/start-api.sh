#!/bin/bash
# Genesis api (launchd) — runs from the PERMANENT checkout so cwd never vanishes.
set -euo pipefail
source /Users/broomva/.config/genesis-bot/env.sh
cd /Users/broomva/broomva/apps/genesis
exec bun apps/api/src/index.ts
