# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM node:24-alpine AS base

ARG COMMIT_HASH=""

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

ARG COMMIT_HASH

ENV VITE_COMMIT_HASH=${COMMIT_HASH}
ENV PATH="/root/.bun/bin:${PATH}"

COPY --from=setup /root/.bun/bin/bun /root/.bun/bin/
COPY . .

RUN bun install --frozen-lockfile \
    && bun run build

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ENV NODE_ENV=production

COPY --from=builder /app/build ./build

RUN apk --no-cache add tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && apk del tzdata \
    && adduser -D -s /bin/sh u7chan

USER u7chan
EXPOSE 3000

CMD ["node", "./build/index.js"]