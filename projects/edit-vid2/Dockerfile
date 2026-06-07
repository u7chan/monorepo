# ── Base Stage ──────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

# ── Test Stage ──────────────────────────────────────────────
FROM base AS test
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run format:check
RUN bun run lint
RUN bun test
RUN bun run build

# ── Builder Stage ───────────────────────────────────────────
FROM base AS builder
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build

# ── Final Stage ─────────────────────────────────────────────
FROM oven/bun:1-slim AS final
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src/db ./src/db
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/shared ./src/shared
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/tsconfig.json ./tsconfig.json
VOLUME /app/data
EXPOSE 3000
ENV NODE_ENV=production
CMD ["bun", "run", "./src/server/node-server.ts"]
