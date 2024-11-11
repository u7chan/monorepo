FROM python:3.13-slim

ENV TZ=Asia/Tokyo

ARG USER_NAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# installing uv
COPY --from=ghcr.io/astral-sh/uv:0.5.1 /uv /uvx /bin/

# add vscode user
RUN groupadd --gid ${USER_GID} ${USER_NAME} \
    && useradd -s /bin/bash --uid ${USER_UID} --gid ${USER_GID} -m ${USER_NAME} \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
    sudo \
    && echo ${USER_NAME} ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/${USER_NAME}\
    && chmod 0440 /etc/sudoers.d/${USER_NAME} \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# setup use packages
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    curl \
    git \
    openssh-client \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
