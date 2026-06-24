# Genesis — owned-compute image (BRO-1535). Bakes the Claude Code CLI (NOT
# credentials) so the agent runs INSIDE the container under GENESIS_HOST=local +
# the PRINT engine (`claude -p`) = subscription auth, no tmux.
#
# Auth is by TOKEN, not a mounted credential file: you run `claude setup-token`
# once (on any machine with a browser), then set the printed token as
# CLAUDE_CODE_OAUTH_TOKEN (a runtime secret in .env / Coolify) — never in this
# image or in git. See ./README.md.
#
# ToS: subscription auth relies on the "Claude Code CLI on your own computer"
# carve-out — clean ONLY on hardware you own. On shared/rented PaaS use the keyed
# Railway path (repo-root Dockerfile + GENESIS_HOST=vercel) instead.
#
# ⚠ BUILD-VERIFY REQUIRED: this image was not built in CI (no Docker there). The
# items flagged in ./README.md "Build-verify checklist" must be confirmed on your
# Docker host before relying on it.

FROM oven/bun:1.3.14

# Native-installer deps: git for the agent's VCS ops, curl/ca-certificates for the
# installer. ripgrep ships inside the claude binary. (tmux is NOT needed — the
# print engine runs `claude -p`, not the tmux-driven interactive engine.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bake Claude Code via the NATIVE installer (node-free; installs to ~/.local/bin,
# bundles ripgrep). Pin via CLAUDE_VERSION ("stable" | "latest" | "2.1.89").
# Auto-update DISABLED → deterministic image (bump CLAUDE_VERSION + rebuild).
ARG CLAUDE_VERSION=stable
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"
ENV PATH="/root/.local/bin:${PATH}" \
    DISABLE_AUTOUPDATER=1

WORKDIR /app
COPY package.json bun.lock turbo.json biome.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile

# PRINT engine (claude -p) on the real (mounted) workspace; nested-repo-safe
# (in-place, no git worktree). GENESIS_ENGINE is deliberately UNSET → print.
# (To use the interactive engine instead you must add `tmux` above AND note that
# it does not scrub the agent env the way the print engine does — not recommended
# for this deploy.)
ENV GENESIS_HOST=local \
    GENESIS_WORKSPACE=/workspace \
    GENESIS_NO_WORKTREE=1 \
    GENESIS_DATA_DIR=/data \
    GENESIS_BOT_STATE_DIR=/data/state \
    GENESIS_AGENT_ARGS=--dangerously-skip-permissions
RUN mkdir -p /workspace /data/state

# api by default; the bot service overrides the command in docker-compose.
CMD ["bun", "apps/api/src/index.ts"]
