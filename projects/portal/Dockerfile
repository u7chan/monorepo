# Docker Container Portal - Dockerfile
# マルチステージビルドで最適化されたイメージ

# Stage 1: 依存関係のインストール
FROM oven/bun:1 AS dependencies

WORKDIR /app

# パッケージファイルのみをコピーしてキャッシュを最適化
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Stage 2: ビルド
FROM oven/bun:1 AS builder

WORKDIR /app

# 依存関係をコピー
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json

# ソースコードをコピー
COPY . .

# 本番用ビルド
ENV NODE_ENV=production
RUN bun run build

# Stage 3: 本番環境
FROM oven/bun:1-slim AS production

WORKDIR /app

# 非rootユーザーで実行
RUN groupadd -r appuser && useradd -r -g appuser appuser

# 必要なファイルのみをコピー
COPY --from=builder --chown=appuser:appuser /app/dist ./dist
COPY --from=builder --chown=appuser:appuser /app/package.json ./
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules

# セキュリティ: 不要なパッケージを削除
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 非rootユーザーに切り替え
USER appuser

# アプリケーションのポート
EXPOSE 3000

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/api/hello').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# アプリケーション起動 (distディレクトリから実行する必要がある)
WORKDIR /app/dist
CMD ["bun", "index.js"]
