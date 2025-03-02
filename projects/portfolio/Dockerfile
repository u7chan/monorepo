# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM node:22-slim AS base

ARG USERNAME=app
ARG USER_UID=1000
ARG USER_GID=$USER_UID
ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

ARG COMMIT_HASH

ENV VITE_APP_VERSION=${COMMIT_HASH}

COPY . .

RUN apt-get update \
  && apt-get install --no-install-recommends -y \
  && npm i -g bun \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && bun i \
  && bun run build \
  && rm -rf node_modules \
  && bun i --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG USERNAME
ARG USER_UID
ARG USER_GID

ENV TZ=Asia/Tokyo
ENV PATH=/usr/local/bin:$PATH
ENV NODE_ENV=production

RUN groupmod -g 1234 node \
  && usermod -u 1234 -g 1234 node \
  && groupadd --gid $USER_GID $USERNAME \
  && useradd -s /bin/bash --uid $USER_UID --gid $USER_GID -m $USERNAME

COPY --from=builder /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src/
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER $USERNAME

EXPOSE 3000
CMD ["bunx", "tsx", "./src/node-server.ts"]