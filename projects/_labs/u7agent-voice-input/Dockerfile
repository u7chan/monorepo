FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS test
WORKDIR /app

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
COPY test/ test/
RUN bun test --no-env-file
