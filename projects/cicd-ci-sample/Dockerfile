# -----------------------------------------------
# CI用サンプル - testステージあり
# PR時にCIが発火してビルド検証を行う
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

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG COMMIT_HASH

ENV APP_VERSION="${COMMIT_HASH}"

COPY scripts/ scripts/

RUN echo "=== CI Sample Build Complete ===" && \
    echo "Version: ${APP_VERSION}"

CMD ["echo", "CI sample - use --target=test for CI validation"]
