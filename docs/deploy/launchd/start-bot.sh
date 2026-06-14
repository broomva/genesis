#!/bin/bash
# Genesis Telegram chat-bot (launchd) — runs from the PERMANENT checkout.
set -euo pipefail
source /Users/broomva/.config/genesis-bot/env.sh
cd /Users/broomva/broomva/apps/genesis
exec bun apps/chat-bot/src/index.ts
