
FROM oven/bun:alpine AS bun
FROM node:24-alpine AS builder

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/
WORKDIR /app

COPY . .
RUN bun install
RUN bun run build

FROM node:24-alpine AS runner

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
