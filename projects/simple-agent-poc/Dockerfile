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
COPY agents.yaml ./
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

# ---- builder stage ----
FROM base AS builder

ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}

# Copy source code
COPY agents.yaml ./
COPY src/ src/

# Install production dependencies
RUN uv sync --no-dev --frozen

# ---- final stage ----
FROM python:3.14-slim AS final

ARG COMMIT_HASH=""
ENV APP_VERSION=${COMMIT_HASH}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH=/app/.venv/bin:$PATH

WORKDIR /app

# Create non-root user
RUN groupadd --gid 1000 appgroup && \
    useradd --uid 1000 --gid appgroup --shell /bin/false appuser

# Copy virtual environment
COPY --from=builder /app/.venv /app/.venv

# Copy application code
COPY --from=builder /app/agents.yaml /app/agents.yaml
COPY --from=builder /app/src /app/src

# Switch to non-root user
USER appuser

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "simple_agent_poc.entrypoints.main_api:app", "--host", "0.0.0.0", "--port", "8000"]
