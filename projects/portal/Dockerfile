# Docker Container Portal - Dockerfile
# マルチステージビルドで最適化されたイメージ

ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1 AS base

WORKDIR /app

# -----------------------------------------------
# test stage
# -----------------------------------------------
FROM base AS test

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run lint

# -----------------------------------------------
# dependencies stage
# -----------------------------------------------
FROM base AS dependencies

# パッケージファイルのみをコピーしてキャッシュを最適化
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM oven/bun:1-slim AS final

WORKDIR /app

# 非rootユーザーで実行（dockerグループも追加）
RUN groupadd -r appuser && \
    useradd -r -g appuser appuser

# Docker CLI のインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# 必要なファイルのみをコピー
COPY --from=dependencies --chown=appuser:appuser /app/package.json ./
COPY --from=dependencies --chown=appuser:appuser /app/node_modules ./node_modules
COPY --chown=appuser:appuser bunfig.toml ./
COPY --chown=appuser:appuser tsconfig.json ./
COPY --chown=appuser:appuser src ./src

# 非rootユーザーに切り替え
USER appuser

# アプリケーションのポート
EXPOSE 3000

# ヘルスチェック
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3000/api/hello').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# アプリケーション起動
CMD ["bun", "run", "start"]
