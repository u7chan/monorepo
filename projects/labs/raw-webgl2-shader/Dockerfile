ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1.3.10 AS base

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

WORKDIR /app

# -----------------------------------------------
# test stage
# -----------------------------------------------
FROM base AS test

COPY package.json ./
RUN bun install

COPY . .
RUN bun test

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM nginxinc/nginx-unprivileged:1.30.2-alpine AS final

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
LABEL org.opencontainers.image.revision="${COMMIT_HASH}"

COPY --chown=101:101 index.html /usr/share/nginx/html/index.html
COPY --chown=101:101 src /usr/share/nginx/html/src

EXPOSE 8080
