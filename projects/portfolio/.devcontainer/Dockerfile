FROM node:22-slim

ENV TZ=Asia/Tokyo

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    curl \
    git \
    openssh-client \
    && npm i -g bun \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN groupmod -g 1234 node \
    && usermod -u 1234 -g 1234 node

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd -s /bin/bash --uid $USER_UID --gid $USER_GID -m $USERNAME
