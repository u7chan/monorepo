# -----------------------------------------------
# pnpm サンプル - マルチステージビルド
# -----------------------------------------------
FROM node:24-alpine AS base

WORKDIR /app

# Corepack は Node 25 で削除されるため使わない
RUN npm install -g pnpm@10.34.5

# -----------------------------------------------
# test stage
# CIワークフローで --target=test を指定してビルド
# -----------------------------------------------
FROM base AS test

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

RUN pnpm lint && pnpm test

# -----------------------------------------------
# builder stage
# TypeScript をコンパイルして dist を生成
# -----------------------------------------------
FROM base AS builder

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm run build

# -----------------------------------------------
# final stage
# ビルド済みの dist のみを実行イメージへコピー
# -----------------------------------------------
FROM base AS final

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

COPY --from=builder /app/dist ./dist

USER node

CMD ["node", "dist/main.js"]
