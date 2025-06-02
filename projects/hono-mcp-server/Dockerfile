FROM oven/bun:alpine AS base

FROM base AS build

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --production

# Copy the rest of the application
COPY src ./src
COPY tsconfig.json ./

FROM base AS runner

ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

WORKDIR /app

# Set the timezone to Asia/Tokyo
RUN apk add --no-cache tzdata \
  && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
  && echo "Asia/Tokyo" > /etc/timezone \
  && adduser -D -s /bin/sh u7chan

# Copy only the necessary files from the build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./

# Set the user to a non-root user
USER u7chan

# Expose the port the app runs on
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]