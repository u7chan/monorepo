FROM python:3.13-slim AS base

WORKDIR /app

FROM base AS builder

ENV UV_LINK_MODE=copy

COPY . .

RUN --mount=from=ghcr.io/astral-sh/uv,source=/uv,target=/bin/uv \
  uv sync --no-dev --frozen

FROM base AS final
ARG USERNAME=pyuser

ENV PATH=/app/.venv/bin:$PATH

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv /app/.venv
COPY --from=builder /app/main.py /app/main.py

RUN useradd -m $USERNAME

USER $USERNAME

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0"]