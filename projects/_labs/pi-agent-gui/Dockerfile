# Keep Node and pnpm aligned with the monorepo CI.
FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@10.34.5
WORKDIR /app

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json

FROM manifests AS dependencies
RUN pnpm install --frozen-lockfile
COPY client/ ./client/
COPY server/ ./server/

# CI: no credentials or live model calls; API tests use a stub runtime.
FROM dependencies AS test
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}
RUN pnpm typecheck && pnpm test && pnpm build

FROM test AS builder

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# CD: the existing pipeline builds final and pushes monorepo/pi-agent-gui.
FROM node:24-bookworm-slim AS final
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace && chown node:node /workspace
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    PI_APP_CWD=/workspace
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=builder /app/server/src/ ./server/src/
COPY --from=builder /app/client/dist/ ./client/dist/
USER node
WORKDIR /app/server
EXPOSE 4317
CMD ["node", "--import", "tsx", "src/index.ts"]
