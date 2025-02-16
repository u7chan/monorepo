FROM node:22-alpine

ENV TZ=Asia/Tokyo

RUN apk add --no-cache shadow bash curl git openssh-client

RUN usermod -l vscode node && \
  groupmod -n vscode node && \
  usermod -d /home/vscode -m vscode

RUN echo 'export PS1="\[\e[1;32m\]\u@\h\[\e[0m\] $ "' >> /home/vscode/.bashrc
