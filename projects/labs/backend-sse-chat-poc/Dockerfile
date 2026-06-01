FROM ghcr.io/astral-sh/uv:bookworm-slim AS base

ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}
ENV UV_LINK_MODE=copy
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

COPY .python-version pyproject.toml uv.lock README.md ./
RUN uv python install 3.14

FROM base AS test

ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}

RUN --mount=type=bind,source=src,target=/app/src \
  --mount=type=bind,source=templates,target=/app/templates \
  --mount=type=bind,source=tests,target=/app/tests \
  uv sync --frozen && \
  uv run ruff format --check . && \
  uv run ruff check . && \
  uv run pytest -v

FROM base AS builder

COPY src ./src
COPY templates ./templates
RUN uv sync --frozen --no-dev

FROM base AS final

ARG USERNAME=pyuser
ARG COMMIT_HASH
ENV COMMIT_HASH=${COMMIT_HASH}
ENV PATH=/app/.venv/bin:$PATH
ENV APP_VERSION=${COMMIT_HASH}

RUN useradd --create-home --shell /bin/bash ${USERNAME}

COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/.venv /app/.venv
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/src /app/src
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/templates /app/templates
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/.python-version /app/.python-version
COPY --from=builder --chown=${USERNAME}:${USERNAME} /app/pyproject.toml /app/pyproject.toml

USER ${USERNAME}

EXPOSE 8000
CMD ["uvicorn", "backend_sse_chat_poc.main:app", "--host", "0.0.0.0", "--port", "8000"]
