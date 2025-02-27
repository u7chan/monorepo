# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM python:3.13-alpine AS base

ARG USERNAME=pyuser
ARG COMMIT_HASH=""

WORKDIR /app
COPY . .

# -----------------------------------------------
# test stage (--target=testを付けてビルド)
#  > example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
COPY --from=base /app .

RUN uv sync
RUN python -m pytest

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
COPY --from=base /app .

RUN uv sync --frozen --no-dev

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG USERNAME
ARG COMMIT_HASH

ENV TZ=Asia/Tokyo
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_VERSION=${COMMIT_HASH}

RUN adduser -D $USERNAME

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv ./.venv
COPY --from=builder --chown=$USERNAME:$USERNAME /app/src ./src

USER $USERNAME

EXPOSE 8000
CMD ["python", ".venv/bin/uvicorn", "src.main:app", "--host", "0.0.0.0"]
