# Genesis — owned-compute image (BRO-1535). Bakes the Claude Code CLI (NOT
# credentials) so the agent runs INSIDE the container under GENESIS_HOST=local +
# the PRINT engine (`claude -p`) = subscription auth, no tmux.
#
# Auth is by TOKEN, not a mounted credential file: run `claude setup-token` once
# (any machine with a browser), set the printed token as CLAUDE_CODE_OAUTH_TOKEN
# (a runtime secret in .env / Coolify) — never in this image or in git.
#
# Runs as the image's built-in NON-ROOT `bun` user (uid 1000): smaller blast
# radius for a skip-permissions agent, and avoids the root +
# --dangerously-skip-permissions guard. ⇒ Your GENESIS_WORKSPACE_HOST must be
# readable/writable by uid 1000 (the common default host user); otherwise the
# agent hits permission errors on the /workspace bind mount.
#
# ToS: subscription auth relies on the "Claude Code CLI on your own computer"
# carve-out — clean ONLY on hardware you own. On shared/rented PaaS use the keyed
# Railway path (repo-root Dockerfile + GENESIS_HOST=vercel) instead.
#
# ⚠ BUILD-VERIFY REQUIRED: not built in CI (no Docker there). Run the checklist in
# ./README.md on your Docker host before relying on it.

FROM oven/bun:1.3.14

# System deps (root): git for the agent's VCS ops, curl/ca-certificates for the
# native installer. ripgrep ships inside the claude binary; tmux is NOT needed
# (print engine, not the tmux-driven interactive engine).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /data/state \
 && chown -R bun:bun /app /workspace /data

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock turbo.json biome.json tsconfig.base.json ./
COPY --chown=bun:bun packages ./packages
COPY --chown=bun:bun apps ./apps

# Everything below runs as the non-root bun user.
USER bun
RUN bun install --frozen-lockfile

# Bake Claude Code via the NATIVE installer AS the bun user, so its launcher +
# versioned binary land coherently under /home/bun/.local (node-free; bundles
# ripgrep). Pin via CLAUDE_VERSION; auto-update DISABLED → deterministic image.
ARG CLAUDE_VERSION=stable
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}"
ENV PATH="/home/bun/.local/bin:${PATH}" \
    DISABLE_AUTOUPDATER=1

# PRINT engine (claude -p) on the real (mounted) workspace; nested-repo-safe
# (in-place, no git worktree). GENESIS_ENGINE deliberately UNSET → print. (To use
# the interactive engine you must add `tmux` above AND note it does not scrub the
# agent env the way the print engine does — not recommended for this deploy.)
ENV GENESIS_HOST=local \
    GENESIS_WORKSPACE=/workspace \
    GENESIS_NO_WORKTREE=1 \
    GENESIS_DATA_DIR=/data \
    GENESIS_BOT_STATE_DIR=/data/state \
    GENESIS_AGENT_ARGS=--dangerously-skip-permissions

# api by default; the bot service overrides the command in docker-compose.
CMD ["bun", "apps/api/src/index.ts"]
