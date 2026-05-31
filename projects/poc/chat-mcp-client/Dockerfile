# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:alpine AS base

ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# test stage
#  > example: `docker build -t test_image . --target=test --progress plain --no-cache`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo

COPY . .

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone \
    && bun install --frozen-lockfile \
    && bun run lint \
    && bun run test

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY package.json bun.lock ./
COPY src ./src
COPY tsconfig.json ./

RUN bun install --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone \
    && adduser -D -s /bin/sh u7chan

USER u7chan
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]