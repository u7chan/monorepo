FROM oven/bun:1.3.10 AS test

WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .
RUN bun test
