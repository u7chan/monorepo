FROM oven/bun:alpine AS base

FROM base AS dev

ENV SHELL="/bin/bash"
ENV TZ=Asia/Tokyo

RUN apk update && apk add --no-cache \
    bash \
    git \
    openssh \
    curl \
    tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone \
    && adduser -D -s /bin/sh vscode
