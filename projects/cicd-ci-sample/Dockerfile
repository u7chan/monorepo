# -----------------------------------------------
# CI専用サンプル - testステージのみ
# PR時にCIが発火してビルド検証を行う
# finalステージがないため、CD対象外となりイメージはビルドされない
# -----------------------------------------------

FROM alpine:3.21 AS base

ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# test stage
# CIワークフローで --target=test を指定してビルド
# -----------------------------------------------
FROM base AS test

COPY scripts/ scripts/
COPY tests/ tests/

RUN echo "=== Running tests (CI validation) ===" && \
    chmod +x scripts/test.sh && \
    ./scripts/test.sh

# finalステージはない - このプロジェクトはCI専用
