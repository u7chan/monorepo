# CI専用（testステージのみ）。
# ブラウザでの同意と、ホスト側の資格情報ファイル（0600）が前提のサンプルなので、
# Docker では起動しない。ここでは型チェックとテストだけを回す。
FROM oven/bun:alpine AS base

WORKDIR /app

ARG COMMIT_HASH=""

# -----------------------------------------------
# test stage
#   - example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json ./
COPY src ./src
COPY tests ./tests

RUN bun run lint \
    && bun run test
