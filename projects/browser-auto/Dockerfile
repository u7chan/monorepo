ARG BUN_VERSION=1.3.10
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:${BUN_VERSION} AS base

WORKDIR /app

COPY package.json bun.lock ./

# -----------------------------------------------
# dependencies stage
# -----------------------------------------------
FROM base AS dependencies

RUN bun install --frozen-lockfile

# -----------------------------------------------
# build stage
# -----------------------------------------------
FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

RUN bun run build

# -----------------------------------------------
# test stage
# -----------------------------------------------
FROM base AS test

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}

COPY --from=dependencies /app/node_modules ./node_modules
COPY .gitignore .oxfmtrc.json .oxlintrc.json tsconfig.json ./
COPY src ./src

RUN bun run lint && \
    bun run format:check && \
    bunx tsc --noEmit

# -----------------------------------------------
# production dependencies stage
# -----------------------------------------------
FROM base AS production-dependencies

ENV NODE_ENV=production

RUN bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
# TODO: Use the Playwright image when browser automation is implemented.
FROM oven/bun:${BUN_VERSION} AS final

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src

RUN mkdir -p /data && chown bun:bun /data

USER bun

VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server/bun-server.ts"]
