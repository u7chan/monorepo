FROM oven/bun:1

WORKDIR /app

COPY packages ./packages
COPY package.json bun.lock index.ts ./

RUN bun install

CMD ["bun", "run", "index.ts"]