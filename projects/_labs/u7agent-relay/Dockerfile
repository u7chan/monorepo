FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS test

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
WORKDIR /app
COPY server.mjs server.test.mjs ./
USER node
RUN node --test
