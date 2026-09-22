# Keep Node and pnpm aligned with the monorepo CI.
FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@10.34.5
WORKDIR /app

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm check が読む lint / format の設定。CI は Docker 内で check を実行するので、ここで渡さないと
# oxlint は shadcn ルールを無言でスキップし、oxfmt はデフォルト設定で判定して format:check が落ちる。
COPY .oxlintrc.json .oxfmtrc.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json

# fd は pi SDK の find ツールが起動する。Debian bookworm の fd-find (8.6.0) は find が渡す --no-require-git
# (fd 9.0 で追加) を受け付けず git 管理外のディレクトリで必ず失敗するため、リリースバイナリを固定する。
# test / final の両方で使う (テストは find を実行する)。
FROM node:24-bookworm-slim AS fd
COPY scripts/install-fd.mjs /tmp/install-fd.mjs
RUN node /tmp/install-fd.mjs /usr/local/bin

FROM manifests AS dependencies
RUN pnpm install --frozen-lockfile
COPY client/ ./client/
COPY server/ ./server/

# CI: no credentials or live model calls; API tests use a stub runtime.
FROM dependencies AS test
COPY --from=fd /usr/local/bin/fd /usr/local/bin/fd
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}
RUN pnpm check

FROM test AS builder

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# CD: the existing pipeline builds final and pushes monorepo/u7agent.
# BFF とサンドボックス (src/sandbox/index.ts) は同一イメージを command 差し替えで共用する。
# server/src/ には組み込みスキルの SKILL.md (src/builtin-skills/) も含めて同梱する。
FROM node:24-bookworm-slim AS final
# curl / jq / file / unzip / xz / zip はサンドボックス内のエージェントが HTTP 取得とアセット検証に使う。
# HTTP の正規手段を curl にして `node -e` のワンライナー fetch へ迂回させないのが目的で、同じ一覧を
# server/src/agent.ts の APPEND_SYSTEM_PROMPT が名指しする。apt 行から落ちたら command -v 検査でビルドを失敗させる。
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep ca-certificates \
    curl jq file unzip xz-utils zip \
    && for tool in bash git rg curl jq file unzip xz zip; do command -v "$tool" >/dev/null || exit 1; done \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /session-store && chown node:node /workspace /session-store
COPY --from=fd /usr/local/bin/fd /usr/local/bin/fd
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    SANDBOX_PORT=8080 \
    PI_APP_CWD=/workspace \
    PI_SANDBOX_CWD=/workspace \
    PI_SESSION_STORE=/session-store
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=builder /app/server/src/ ./server/src/
COPY --from=builder /app/client/dist/ ./client/dist/
USER node
WORKDIR /app/server
EXPOSE 4317 8080
CMD ["node", "--import", "tsx", "src/index.ts"]
