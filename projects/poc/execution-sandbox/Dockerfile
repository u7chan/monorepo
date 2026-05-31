FROM oven/bun:1.3.10-alpine AS base

ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}

WORKDIR /app

COPY package.json bun.lock ./

FROM base AS deps

RUN bun install --frozen-lockfile

FROM base AS test

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY tests ./tests
COPY tsconfig.json ./

RUN bun run typecheck && \
    bun test

FROM base AS production-deps

ENV NODE_ENV=production

RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

FROM base AS final

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
ENV NODE_ENV=production
ENV PORT=3000

RUN adduser -D -s /sbin/nologin execution

COPY --from=production-deps --chown=execution:execution /app/node_modules ./node_modules
COPY --from=production-deps --chown=execution:execution /app/src ./src
COPY --from=production-deps --chown=execution:execution /app/tsconfig.json ./tsconfig.json

USER execution

EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
