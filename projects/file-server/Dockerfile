# -----------------------------------------------
# base stage
# -----------------------------------------------
# Bun は final の実行バイナリ、Node.js はベース OS と `node` コマンドのために含む。どちらも可変タグ
# (`alpine`) のままだと同じコミットの再ビルドで中身が変わるため、版と digest で固定する。1.4.4 は
# Node2Shell の修正が入る最初の Bun 安定版、26.13.1 は 2026-11 の Node.js セキュリティリリース版。
# digest は linux/amd64 と arm64 を含むマルチアーキテクチャの manifest index で、プラットフォーム別
# manifest ではない。Bun と Node.js は別イメージなので個別に固定する。更新は Dependabot の
# `/projects/file-server` docker エントリで受ける。アプリの実行主体は Bun のまま変えない。
FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS bun
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/

RUN apk add --no-cache zip

# -----------------------------------------------
# test stage
#   - example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo

COPY . ./

RUN bun install --frozen-lockfile \
    && bun run lint \
    && bun run test

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/uploads

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY tsconfig.json ./tsconfig.json

RUN mkdir -p $UPLOAD_DIR /app/auth && \
    chown -R node:node $UPLOAD_DIR /app/auth

USER node

CMD ["bun", "run", "./src/index.tsx"]
