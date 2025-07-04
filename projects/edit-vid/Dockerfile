ARG PYTHON_VERSION=3.13

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS base

ARG USERNAME=pyuser
ARG UID=1000
ARG COMMIT_HASH=""

WORKDIR /app

# -----------------------------------------------
# dev stage
# -----------------------------------------------
FROM base AS dev

ARG UID
ARG USERNAME

ENV TZ=Asia/Tokyo
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt update && apt-get update \
  && apt-get install --no-install-recommends -y curl git openssh-client ffmpeg fonts-ipafont \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && adduser --uid "${UID}" "${USERNAME}"

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

RUN adduser --uid "${UID}" "${USERNAME}" \
  && chown -R $USERNAME:$USERNAME /app

COPY --from=builder --chown=$USERNAME:$USERNAME /app/.venv .venv
COPY --from=builder --chown=$USERNAME:$USERNAME /app/src src

USER $USERNAME

EXPOSE 8000
CMD ["fastapi", "run", "src/main.py", "--port", "8000"]
