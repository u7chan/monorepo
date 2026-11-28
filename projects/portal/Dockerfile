# Docker Container Portal - Dockerfile
# マルチステージビルドで最適化されたイメージ

ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
# 1.4.5 は Node2Shell の修正を含む安定版。可変タグ (`1`) のままだと同じコミットでも再ビルドで
# Bun のパッチ版と OS パッケージが変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を
# 含むマルチアーキテクチャの manifest index で、プラットフォーム別 manifest ではない。slim は別の
# manifest なので final 側で個別に固定する。更新は Dependabot の docker エントリで受ける。
# package.json の devDependency `bun` も同じ版で固定している。`bun run` は node_modules/.bin を PATH の
# 先頭に足すため、ここだけ上げると scripts 内の `bun`（start / test）が古いまま動く。更新時は両方揃える。
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS base

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
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS final

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
