# Bun のバージョンは monorepo の他プロジェクトと揃える。HTML のバンドルと SQLite は Bun が持つため、final に Node.js は入れない。
ARG BUN_VERSION=1.3.14
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:${BUN_VERSION} AS base

WORKDIR /app

# -----------------------------------------------
# dependencies stage
# -----------------------------------------------
FROM base AS dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

# -----------------------------------------------
# test stage
#   - example: `docker build --target test --progress plain ./projects/usage-portal`
# -----------------------------------------------
FROM dependencies AS test

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}

COPY package.json bun.lock tsconfig.json .oxfmtrc.json ./
COPY index.html ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY docs ./docs
COPY README.md AGENTS.md .env.example ./

RUN bun run check

# -----------------------------------------------
# production dependencies stage
# -----------------------------------------------
FROM base AS production-dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS final

# 上流 API は HTTPS を使う。slim には CA の束が入っていない。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json index.html tsconfig.json ./
COPY --chown=bun:bun src ./src

RUN mkdir -p /app/data && chown bun:bun /app/data && chmod 0700 /app/data

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
