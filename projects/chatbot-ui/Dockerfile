# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM node:22-alpine AS base

WORKDIR /app

# -----------------------------------------------
# setup stage
# -----------------------------------------------
FROM base AS setup

RUN apk add --no-cache bash curl \
    && curl -fsSL https://bun.sh/install -sSf | bash

# -----------------------------------------------
# test stage
#  > example: `docker build -t test_image . --target=test --progress plain --no-cache`
# -----------------------------------------------
FROM base AS test

ENV PATH="/root/.bun/bin:${PATH}"
COPY --from=setup /root/.bun/bin/bun /root/.bun/bin/

COPY . .
RUN bun install --frozen-lockfile \
    && bun run lint \
    && bun run build \
    && bun run test

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

ENV PATH="/root/.bun/bin:${PATH}"
COPY --from=setup /root/.bun/bin/bun /root/.bun/bin/

COPY . .
RUN bun install --frozen-lockfile \
    && bun run build \
    && mkdir -p ./temp/prod

COPY package.json bun.lock ./temp/prod/
RUN cd ./temp/prod \
    && bun install --frozen-lockfile --production

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/temp/prod/node_modules ./node_modules

RUN apk --no-cache add tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && apk del tzdata \
    && adduser -D -s /bin/sh u7chan

USER u7chan
EXPOSE 3000

CMD ["node", "./dist/index.js"]