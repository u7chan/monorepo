# HTML import (バンドラ) と bun:sqlite に依存するので、Node.js へは寄せずに Bun を使う。final にも Node.js は入れない。
# 1.4.4 は 2026-11 時点の修正済み安定版 (`latest` と同一 digest)。可変タグのままだと同じコミットでも
# 再ビルドで中身が変わるため、版と digest で固定する。digest は linux/amd64 と arm64 を含むマルチ
# アーキテクチャの manifest index で、プラットフォーム別 manifest ではない。通常版と slim 版で digest は別。
# ARG で共通化すると Dependabot の docker 更新が FROM 行のリテラルを書き換えられないので、値を各 FROM 行に書く。
ARG COMMIT_HASH=""

# -----------------------------------------------
# base stage
# -----------------------------------------------
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS base

WORKDIR /app

# -----------------------------------------------
# dependencies stage
# -----------------------------------------------
FROM base AS dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

# -----------------------------------------------
# test stage
#   - example: `docker build --target test --progress plain ./projects/usage-portal`
# -----------------------------------------------
FROM dependencies AS test

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH}

COPY package.json bun.lock tsconfig.json .oxfmtrc.json ./
COPY index.html ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY docs ./docs
COPY README.md AGENTS.md .env.example ./
# 帰属表示の同梱と参照先を test/license-notices.test.ts が読む。
COPY Dockerfile THIRD_PARTY_NOTICES.txt ./

RUN bun run check

# -----------------------------------------------
# production dependencies stage
# -----------------------------------------------
FROM base AS production-dependencies

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# -----------------------------------------------
# claude cli stage
#   公式 CLI をビルド時に落として checksum を突き合わせ、final にはバイナリだけを渡す。
#   final に curl / jq を残さないことと、image の層を増やさないことが目的。
#   版を上げるときは CLAUDE_CODE_VERSION を変えて、adapter の fixture（test/providers-claude.test.ts）を
#   実際の出力と突き合わせ直す。
# -----------------------------------------------
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS claude-cli

ARG CLAUDE_CODE_VERSION="2.1.327"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$(uname -m)" in \
        x86_64|amd64) platform="linux-x64" ;; \
        aarch64|arm64) platform="linux-arm64" ;; \
        *) echo "未対応のアーキテクチャです: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    base="https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}"; \
    curl -fsSL "$base/manifest.json" -o /tmp/manifest.json; \
    checksum="$(jq -r --arg platform "$platform" '.platforms[$platform].checksum // empty' /tmp/manifest.json)"; \
    test -n "$checksum"; \
    curl -fsSL "$base/$platform/claude" -o /tmp/claude; \
    echo "$checksum  /tmp/claude" | sha256sum -c -; \
    mkdir -p /opt/claude; \
    install -m 0755 /tmp/claude /opt/claude/claude; \
    rm -f /tmp/claude /tmp/manifest.json; \
    CLAUDE_CONFIG_DIR=/tmp/claude-check /opt/claude/claude --version; \
    rm -rf /tmp/claude-check

# -----------------------------------------------
# final stage
# -----------------------------------------------
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS final

# 上流 API は HTTPS を使う。slim には CA の束が入っていない。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG COMMIT_HASH

ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    CREDENTIAL_DIR=/app/credentials \
    CLAUDE_CONFIG_DIR=/app/credentials/claude \
    PI_CODING_AGENT_DIR=/app/credentials

WORKDIR /app

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json index.html tsconfig.json ./
# provider のロゴの商標表示。配布物（この image）にも含める。
COPY --chown=bun:bun THIRD_PARTY_NOTICES.txt ./
COPY --chown=bun:bun src ./src

# 公式 CLI は未改変のバイナリを入れる。root 所有の 0755 にして、実行ユーザー (bun) からは
# 書き換えられないようにする。これが自動更新を止める仕組みで、版は上の ARG で固定する。
COPY --from=claude-cli --chown=root:root /opt/claude/claude /usr/local/bin/claude

# DATA_DIR と CREDENTIAL_DIR は volume の mount point。イメージ側でも 0700 にしておく。
# CLAUDE_CONFIG_DIR は CLI が資格情報を書く場所で、docker exec でサインインする先でもある。
RUN mkdir -p /app/data /app/credentials /app/credentials/claude \
    && chown bun:bun /app/data /app/credentials /app/credentials/claude \
    && chmod 0700 /app/data /app/credentials /app/credentials/claude

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/server.ts"]
