# -----------------------------------------------
# CD用サンプル - 通常のマルチステージビルド
# mainブランチマージ時にCDが発火してイメージをビルド・プッシュ
# -----------------------------------------------

FROM alpine:3.21 AS base

ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY src/ src/

RUN echo "=== Building application ===" && \
    mkdir -p dist && \
    echo "Build completed at $(date)" > dist/build-info.txt && \
    cp src/* dist/ 2>/dev/null || true

# -----------------------------------------------
# final stage
# CDワークフローでビルド・プッシュされる
# -----------------------------------------------
FROM base AS final

ARG COMMIT_HASH

ENV APP_VERSION="${COMMIT_HASH}"

COPY --from=builder /app/dist/ dist/

RUN echo "=== CD Sample Build Complete ===" && \
    echo "Version: ${APP_VERSION}" && \
    cat dist/build-info.txt

CMD ["cat", "dist/build-info.txt"]
