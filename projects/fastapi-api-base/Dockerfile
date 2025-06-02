# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM python:3.13-alpine AS base

ARG USERNAME=pyuser
ARG UID=1000
ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# dev stage
# -----------------------------------------------
FROM base AS dev

ENV TZ=Asia/Tokyo
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN adduser \
  --disabled-password \
  --uid "${UID}" \
  vscode

# -----------------------------------------------
# test stage (--target=testを付けてビルド)
#  > example: `docker build -t ex --target=test --progress plain .`
# -----------------------------------------------
FROM base AS test

ENV TZ=Asia/Tokyo
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN --mount=type=bind,source=src,target=src \
  --mount=type=bind,source=tests,target=tests \
  --mount=type=bind,source=uv.lock,target=uv.lock \
  --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
  uv sync \
  && uv run -m pytest -s -vv --tb=short --cov

# -----------------------------------------------
# builder stage
# -----------------------------------------------
FROM base AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
COPY src src

RUN --mount=type=bind,source=uv.lock,target=uv.lock \
  --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
  uv sync --no-dev --frozen

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM base AS final

ARG USERNAME
ARG COMMIT_HASH

ENV TZ=Asia/Tokyo
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/app/.venv/bin:$PATH"
ENV APP_VERSION="${COMMIT_HASH}"

RUN adduser -D $USERNAME

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv .venv
COPY --from=builder --chown=$USERNAME:$USERNAME /app/src src

USER $USERNAME

EXPOSE 8000
CMD ["fastapi", "run", "src/main.py", "--port", "8000"]