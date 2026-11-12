# Docker Container Portal - Dockerfile
# マルチステージビルドで最適化されたイメージ

ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
# 1.4.4 は Node2Shell の修正が入る最初の安定版。可変タグ (`1`) のままだと同じコミットでも再ビルドで
# Bun のパッチ版と OS パッケージが変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を
# 含むマルチアーキテクチャの manifest index で、プラットフォーム別 manifest ではない。slim は別の
# manifest なので final 側で個別に固定する。更新は Dependabot の docker エントリで受ける。
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS base

WORKDIR /app

# -----------------------------------------------
# test stage
# -----------------------------------------------
FROM base AS test

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run lint \
    && bun run test

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
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS final

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
