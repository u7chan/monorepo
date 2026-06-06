ARG BASE_PYTHON
FROM python:${BASE_PYTHON} AS runner

ARG USER_NAME=python
ARG USER_UID=1000
ARG USER_GID=${USER_UID}
ARG TZ=Asia/Tokyo
ARG APT_PACKAGES=""

ENV TZ=${TZ}

RUN groupadd --gid ${USER_GID} ${USER_NAME} \
    && useradd -s /bin/bash --uid ${USER_UID} --gid ${USER_GID} -m ${USER_NAME}

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
    bash \
    ${APT_PACKAGES} \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# installing uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

USER ${USER_NAME}
CMD ["sleep", "infinity"]
