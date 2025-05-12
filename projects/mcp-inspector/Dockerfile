FROM node:24-alpine AS base

WORKDIR /app

FROM base AS builder

COPY package.json package-lock.json ./
RUN npm ci

FROM base AS runner

COPY --from=builder /app/node_modules ./node_modules

RUN adduser -D -s /bin/sh u7chan
USER u7chan

EXPOSE 6274
CMD ["node", "node_modules/.bin/mcp-inspector"]