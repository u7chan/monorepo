# HTML import（バンドラ）と bun:sqlite に依存するので、Node.js へは寄せずに Bun を使う。
# 1.4.4 は 2026-11 時点の安定版。可変タグのままだと同じコミットでも再ビルドで中身が変わるため、
# 版と digest で固定する。digest は linux/amd64 と arm64 を含むマルチアーキテクチャの manifest index で、
# プラットフォーム別 manifest ではない。通常版と slim 版で digest は別。
# ARG で共通化すると Dependabot の docker 更新が FROM 行のリテラルを書き換えられないので、値を各 FROM 行に書く。
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS base

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
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS final

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
    CMD bun -e "const host = (process.env.HOST || '').trim(); const target = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host; const raw = (process.env.PORT || '').trim(); const port = raw === '' ? 8787 : Number(raw); if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1); fetch('http://' + target + ':' + port + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
