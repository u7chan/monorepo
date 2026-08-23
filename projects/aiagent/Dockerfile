ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1.3-alpine AS base

WORKDIR /app

# -----------------------------------------------
# test stage
#   - example: `docker build -t aiagent --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo

COPY . ./

RUN bun install --frozen-lockfile \
    && bun run lint \
    && bun run test

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun tsconfig.json ./tsconfig.json

EXPOSE 3000

USER bun

CMD ["bun", "run", "./src/index.ts"]
