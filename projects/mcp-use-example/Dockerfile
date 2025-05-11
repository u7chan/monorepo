FROM python:3.13-alpine AS base

ENV TZ=Asia/Tokyo

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apk add --no-cache tzdata \
  && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
  && echo "Asia/Tokyo" > /etc/timezone \
  && adduser -D -s /bin/sh u7chan

USER u7chan
