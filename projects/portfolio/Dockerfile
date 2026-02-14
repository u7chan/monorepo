ARG NODE_VERSION=25
ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:debian AS bun
FROM node:${NODE_VERSION}-slim AS base

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
  && apt-get install --no-install-recommends -y sudo curl git openssh-client \
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
  && bun run lint \
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
