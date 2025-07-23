# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:alpine AS bun
FROM node:24-alpine AS base

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/

# -----------------------------------------------
# test stage
#   - example: `docker build -t ex --target=test --progress plain .`
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
# runner stage
# -----------------------------------------------
FROM base AS runner

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/uploads

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src

RUN mkdir -p $UPLOAD_DIR && \
    chown -R node:node $UPLOAD_DIR

USER node

CMD ["bun", "run", "./src/index.tsx"]
