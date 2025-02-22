FROM python:3.13-alpine

ENV TZ=Asia/Tokyo

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apk add --no-cache shadow bash curl git openssh-client \
  && adduser -D vscode \
  && echo 'export PS1="\[\e[1;32m\]\u@\h\[\e[0m\] $ "' >> /home/vscode/.bashrc

USER vscode
