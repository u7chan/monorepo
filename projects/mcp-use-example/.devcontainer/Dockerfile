FROM python:3.12-slim AS base

ENV TZ=Asia/Tokyo

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata && \
    ln -fs /usr/share/zoneinfo/Asia/Tokyo /etc/localtime && \
    dpkg-reconfigure -f noninteractive tzdata && \
    adduser --disabled-password --gecos "" u7chan

USER u7chan
