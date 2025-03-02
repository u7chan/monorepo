# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM node:22-slim AS base

ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder
ARG COMMIT_HASH

ENV VITE_APP_VERSION=${COMMIT_HASH}

COPY --from=oven/bun:latest /usr/local/bin/bun /bin/bun
COPY . .

RUN bun i && \
  bun run build \
  && rm -rf node_modules \
  && bun add tsx \
  && bun i --production

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
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/llm ./src/llm
COPY --from=builder /app/src/node-server.ts ./src/node-server.ts
COPY --from=builder /app/src/server.tsx ./src/server.tsx
COPY --from=builder /app/tsconfig.json ./tsconfig.json

USER node

EXPOSE 3000
CMD ["npx", "tsx", "./src/node-server.ts"]
