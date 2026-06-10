# Genesis engine — Bun/Hono server. Deploys to Railway (always-on).
# In GENESIS_HOST=vercel mode the agent runs in a Vercel Sandbox microVM, so this
# image is a thin orchestrator: no coding-agent CLI baked in.
FROM oven/bun:1.3.14

WORKDIR /app

# Manifest + workspace sources (bun resolves workspace:* via these).
COPY package.json bun.lock turbo.json biome.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile

# Railway injects PORT and DATABASE_URL at runtime. GENESIS_WORKSPACE is unused in
# vercel mode (the microVM is the workdir) but set to a real dir for local mode.
ENV GENESIS_WORKSPACE=/app/.workspace
RUN mkdir -p /app/.workspace

# Bun auto-serves the default export ({ port, fetch, websocket }) on 0.0.0.0:$PORT.
CMD ["bun", "apps/api/src/index.ts"]
