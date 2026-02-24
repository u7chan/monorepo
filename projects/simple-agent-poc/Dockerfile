# CI-only project - test stage only
FROM python:3.14-slim AS base

ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}

WORKDIR /app

# Install uv
RUN pip install --no-cache-dir uv

# Copy dependency files
COPY pyproject.toml uv.lock ./
COPY README.md ./

# Install dependencies
RUN uv sync --frozen --no-install-project

# ---- test stage (REQUIRED for CI) ----
FROM base AS test

ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}

# Copy source code and tests
COPY src/ src/
COPY tests/ tests/

# Install project
RUN uv sync --frozen

# Log commit hash and run tests
RUN echo "Building with commit: ${COMMIT_HASH}" && \
    uv run ruff format --check . && \
    uv run ruff check . && \
    uv run ty check . && \
    uv run pytest -v

# No final stage - CI only
