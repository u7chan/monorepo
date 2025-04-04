FROM node:22-alpine AS base

WORKDIR /app

RUN apk --no-cache add tzdata && \
    cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime && \
    apk del tzdata

RUN adduser -D -s /bin/sh u7chan
USER u7chan