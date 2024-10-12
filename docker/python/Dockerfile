FROM python:3.13-slim

ENV TZ=Asia/Tokyo

ARG USER_NAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# add vscode user
RUN groupadd --gid $USER_GID $USER_NAME \
    && useradd -s /bin/bash --uid $USER_UID --gid $USER_GID -m $USER_NAME \
    && apt-get update \
    && apt-get install -y sudo \
    && echo $USER_NAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USER_NAME\
    && chmod 0440 /etc/sudoers.d/$USER_NAME \
    && apt-get clean

RUN apt-get update \
    && apt-get install -y \
    bash \
    curl \
    git \
    openssh-client \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER $USER_NAME
WORKDIR $USER_NAME

# install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
