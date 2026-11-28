# HTML import (バンドラ) に依存するので、Node.js へは寄せずに Bun を使う。final にも Node.js は入れない。
# 上流の取得はローカルの生成スクリプトだけで、稼働中は外向きの HTTP をしない（CA の束も入れない）。
# 1.4.5 は 2026-11 時点の修正済み安定版。可変タグのままだと同じコミットでも
# 再ビルドで中身が変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を含むマルチ
# アーキテクチャの manifest index で、プラットフォーム別 manifest ではない。通常版と slim 版で digest は別。
# ARG で共通化すると Dependabot の docker 更新が FROM 行のリテラルを書き換えられないので、値を 2 か所に書く。
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
#   - example: `docker build --target test --progress plain ./projects/cost-master`
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
COPY README.md AGENTS.md DESIGN.md .env.example ./

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

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json index.html tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3100/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
