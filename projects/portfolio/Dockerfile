# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM node:22-slim AS base

ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# test stage (--target=testを付けてビルド)
#  > example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo

COPY --from=oven/bun:latest /usr/local/bin/bun /bin/bun
COPY . .

RUN bun install --frozen-lockfile \
  && bun run lint \
  && bun run build

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder
ARG COMMIT_HASH

ENV VITE_APP_VERSION=${COMMIT_HASH}

COPY --from=oven/bun:latest /usr/local/bin/bun /bin/bun
COPY . .

RUN bun install --frozen-lockfile \
  && bun run build

# install with --production (exclude devDependencies)
RUN mkdir -p ./temp/prod
COPY package.json bun.lock ./temp/prod/
RUN cd ./temp/prod \
  && bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG USERNAME
ARG USER_UID
ARG USER_GID

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/temp/prod/node_modules ./node_modules
COPY --from=builder /app/src/llm ./src/llm
COPY --from=builder /app/src/node-server.ts ./src/node-server.ts
COPY --from=builder /app/src/server.tsx ./src/server.tsx
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER node

EXPOSE 3000
CMD ["npx", "tsx", "./src/node-server.ts"]