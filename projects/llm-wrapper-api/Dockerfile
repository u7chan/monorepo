FROM python:3.13-alpine AS base

ARG USERNAME=pyuser
ARG COMMIT_HASH=""

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY . .

RUN uv sync --frozen --no-dev

# -----------------------------------------------
# runner stage
# -----------------------------------------------
FROM base AS runner

ARG USERNAME
ARG COMMIT_HASH

ENV TZ=Asia/Tokyo
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_VERSION=${COMMIT_HASH}

WORKDIR /app

RUN adduser -D $USERNAME

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv ./.venv
COPY --from=builder --chown=$USERNAME:$USERNAME /app/app ./app

USER $USERNAME

EXPOSE 8000
CMD ["python", ".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0"]
