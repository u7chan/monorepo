
FROM oven/bun:alpine AS bun
FROM node:24-alpine AS base
FROM base AS test

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/
COPY . .

RUN bun install
RUN bun run lint

FROM base AS builder

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/
COPY . .

RUN bun install
RUN bun run build

FROM base AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

WORKDIR /app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static

RUN adduser -D appuser && chown -R appuser:appuser /app

USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
