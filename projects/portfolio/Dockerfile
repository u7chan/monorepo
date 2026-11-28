# Node 26 LTS (EOL 2029-04). jsdom 30 requires ^22.22.2 || ^24.15.0 || >=26.0.0, so Node 26 is in range and Node 25 is not.
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
# bun も可変タグ (`debian`) のままだと同じコミットでも再ビルドで中身が変わるため、版と digest で固定する。
# digest は linux/amd64 と arm64 を含むマルチアーキテクチャの manifest index。更新は Dependabot の
# `/projects/portfolio` docker エントリで受ける。
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun
# 26.13.1 は 2026-11-11 のセキュリティリリース版。可変タグ (`26-slim`) のままだと同じコミットでも
# 再ビルドで中身が変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を含む
# マルチアーキテクチャの manifest index で、プラットフォーム別 manifest ではない。`-trixie-slim` を
# 明示するのは、ベースが trixie から動いたときに apt で入れる postgresql-client などが変わるため。
FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS base

WORKDIR /app

# -----------------------------------------------
# dev stage
# -----------------------------------------------
FROM base AS dev

ARG USERNAME
ARG USER_UID
ARG USER_GID

ENV TZ=Asia/Tokyo

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/

RUN groupmod -g 1234 node \
  && usermod -u 1234 -g 1234 node

RUN groupadd --gid $USER_GID $USERNAME \
  && useradd -s /bin/bash --uid $USER_UID --gid $USER_GID -m $USERNAME

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates sudo curl git openssh-client postgresql-client \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g @aikidosec/safe-chain \
  && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
  && chmod 0440 /etc/sudoers.d/${USERNAME}

USER $USERNAME

RUN safe-chain setup

# -----------------------------------------------
# test stage (--target=testを付けてビルド)
#  > example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo

COPY --from=bun /usr/local/bin/bun /usr/local/bin/
COPY . .

RUN bun install --frozen-lockfile \
  && bun run format:check \
  && bun run lint \
  && bun run test:coverage \
  && bun run typegen \
  && bun run build

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

ARG COMMIT_HASH

ENV VITE_APP_VERSION="${COMMIT_HASH}"

COPY --from=bun /usr/local/bin/bun /usr/local/bin/
COPY . .

RUN bun install --frozen-lockfile \
  && bun run build \
  && rm -rf node_modules \
  && bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/db ./src/db
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/types ./src/types
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER node

EXPOSE 3000
CMD ["npx", "tsx", "./src/server/node-server.ts"]
