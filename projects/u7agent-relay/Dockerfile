# HTML import（バンドラ）と bun:sqlite に依存するので、Node.js へは寄せずに Bun を使う。
# 1.4.4 は 2026-11 時点の安定版。可変タグのままだと同じコミットでも再ビルドで中身が変わるため、
# 版と digest で固定する。digest は linux/amd64 と arm64 を含むマルチアーキテクチャの manifest index で、
# プラットフォーム別 manifest ではない。通常版と slim 版で digest は別。
# ARG で共通化すると Dependabot の docker 更新が FROM 行のリテラルを書き換えられないので、値を各 FROM 行に書く。
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
#   - example: `docker build --target test --progress plain ./projects/u7agent-relay`
# -----------------------------------------------
FROM dependencies AS test

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}

COPY package.json bun.lock tsconfig.json .oxfmtrc.json ./
COPY index.html ./
COPY src ./src
COPY test ./test

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

# 上流の u7agent は HTTPS を使う。slim には CA の束が入っていない。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json index.html ./
COPY --chown=bun:bun src ./src

# DATA_DIR は volume の mount point。PIN ハッシュとセッション鍵もここへ置く。
RUN mkdir -p /app/data \
    && chown bun:bun /app/data \
    && chmod 0700 /app/data

USER bun

EXPOSE 8787

# PORT / HOST を変えてもヘルスチェックが追随するように、既定値へ固定しない。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "const host = !process.env.HOST || process.env.HOST === '0.0.0.0' || process.env.HOST === '::' ? '127.0.0.1' : process.env.HOST; const port = process.env.PORT || '8787'; fetch('http://' + host + ':' + port + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
