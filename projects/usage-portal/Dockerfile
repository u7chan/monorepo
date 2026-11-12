# HTML import (バンドラ) と bun:sqlite に依存するので、Node.js へは寄せずに Bun を使う。final にも Node.js は入れない。
# 1.4.4 は 2026-11 時点の修正済み安定版 (`latest` と同一 digest)。可変タグのままだと同じコミットでも
# 再ビルドで中身が変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を含むマルチ
# アーキテクチャの manifest index で、プラットフォーム別 manifest ではない。通常版と slim 版で digest は別。
# ARG で共通化すると Dependabot の docker 更新が FROM 行のリテラルを書き換えられないので、値を 2 か所に書く。
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS base

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
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS final

# 上流 API は HTTPS を使う。slim には CA の束が入っていない。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    CREDENTIAL_DIR=/app/credentials \
    PI_CODING_AGENT_DIR=/app/credentials

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json index.html tsconfig.json ./
COPY --chown=bun:bun src ./src

# DATA_DIR と CREDENTIAL_DIR は volume の mount point。イメージ側でも 0700 にしておく。
RUN mkdir -p /app/data /app/credentials \
    && chown bun:bun /app/data /app/credentials \
    && chmod 0700 /app/data /app/credentials

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
