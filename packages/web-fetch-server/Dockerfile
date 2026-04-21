# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Builder: compile workspace packages required at runtime (Bun + TypeScript).
# Context: repository root (e.g. docker build -f packages/web-fetch-server/Dockerfile .)
# Ignore file: `Dockerfile.dockerignore` in this directory is auto-picked by BuildKit.
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages

RUN bun install --frozen-lockfile \
  && bun run --filter '@tachu/core' build \
  && bun run --filter '@tachu/web-fetch-server' build

# -----------------------------------------------------------------------------
# Runner: Playwright Jammy image ships Chromium under /ms-playwright; Bun is installed.
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.48.0-jammy AS runner

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && curl -fsSL https://bun.sh/install | bash \
  && install -m 755 /root/.bun/bin/bun /usr/local/bin/bun \
  && rm -rf /root/.bun \
  && apt-get purge -y unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bun workspaces use isolated install: each workspace keeps its own node_modules
# with symlinks into the root `node_modules/.bun/<pkg>@<ver>/`. All three node_modules
# layers (root + each workspace) must be present for symlinks to resolve at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/extensions ./packages/extensions
COPY --from=builder /app/packages/web-fetch-server/package.json ./packages/web-fetch-server/package.json
COPY --from=builder /app/packages/web-fetch-server/node_modules ./packages/web-fetch-server/node_modules
COPY --from=builder /app/packages/web-fetch-server/dist ./packages/web-fetch-server/dist

RUN chown -R pwuser:pwuser /app

WORKDIR /app/packages/web-fetch-server

ENV NODE_ENV=production
ENV WEB_FETCH_HOST=0.0.0.0
ENV WEB_FETCH_PORT=8787
ENV WEB_FETCH_LOG_FORMAT=jsonl
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Playwright v1.48.0 bundles Chromium revision 1140 (see playwright v1.48.0 browsers.json).
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/ms-playwright/chromium-1140/chrome-linux/chrome

EXPOSE 8787

USER pwuser

CMD ["bun", "run", "dist/main.js"]
