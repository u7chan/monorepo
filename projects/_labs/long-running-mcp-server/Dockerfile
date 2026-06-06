FROM oven/bun:alpine AS base

FROM base AS dev

ENV SHELL="/bin/bash"
ENV TZ=Asia/Tokyo

RUN apk update && apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone

RUN apk update && apk add --no-cache \
    bash \
    git \
    openssh \
    curl

RUN adduser -D -s /bin/sh vscode

FROM base AS prod

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

WORKDIR /app

COPY package.json bun.lock tsconfig.json .
COPY src ./src

RUN bun install --production

RUN apk update && apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone

RUN adduser -D -s /bin/sh mcp

USER mcp

EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
