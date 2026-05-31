FROM python:3.13-slim AS base
FROM base AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY hello.py .
COPY hello.csv .
COPY pyproject.toml .
COPY uv.lock .

RUN uv sync --no-dev

FROM base AS runner

ENV PATH=/app/.venv/bin:$PATH

COPY --from=builder /app /app

WORKDIR /app

RUN useradd -m python

USER python

CMD ["python", "hello.py"]
