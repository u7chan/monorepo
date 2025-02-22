FROM python:3.13-alpine AS base

ARG USERNAME=pyuser

FROM base AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY . .

RUN uv sync --frozen --no-dev

FROM base AS runner

ARG USERNAME

ENV TZ=Asia/Tokyo
ENV PATH="/app/.venv/bin:$PATH"

WORKDIR /app

RUN adduser -D $USERNAME

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv ./.venv
COPY --from=builder --chown=$USERNAME:$USERNAME /app/main.py ./main.py

USER $USERNAME

EXPOSE 8000
CMD ["python", ".venv/bin/uvicorn", "main:app", "--host", "0.0.0.0"]
