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
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g @google/gemini-cli \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && adduser --uid "${UID}" "${USERNAME}"

# -----------------------------------------------
# python builder stage
# -----------------------------------------------
FROM base AS python-builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
COPY backend backend

RUN --mount=type=bind,source=uv.lock,target=uv.lock \
  --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
  uv sync --no-dev --frozen

# -----------------------------------------------
# frontend builder stage
# -----------------------------------------------
FROM node:24-slim AS frontend-builder

WORKDIR /app/frontend

# Copy package files
COPY frontend/package.json frontend/package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source files and build
COPY frontend/ ./
RUN npm run build

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

RUN apt update && apt-get update \
  && apt-get install --no-install-recommends -y ffmpeg fonts-ipafont \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && adduser --uid "${UID}" "${USERNAME}" \
  && chown -R $USERNAME:$USERNAME /app

COPY --from=python-builder --chown=$USERNAME:$USERNAME /app/.venv .venv
COPY --from=python-builder --chown=$USERNAME:$USERNAME /app/backend backend
COPY --from=frontend-builder --chown=$USERNAME:$USERNAME /app/frontend/dist frontend/dist

USER $USERNAME

EXPOSE 8000
CMD ["fastapi", "run", "backend/main.py", "--port", "8000"]
