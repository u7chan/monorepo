# Keep Node and pnpm aligned with the monorepo CI.
FROM node:24-trixie-slim AS base
RUN npm install --global pnpm@10.34.5
WORKDIR /app

# chromium-headless-shell の実行に要るシステム依存と、日本語ラベル / 絵文字を描くフォント。
# 一覧は playwright-core の nativeDeps (debian13-x64 の chromium) を正とし、ドライバを上げるときは取り直す。
# `test` (PR CI) と `final` (CD) の両方がこの 1 ステージを継承するので、apt を二重定義しない。
FROM base AS browser-libs
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      fonts-ipafont-gothic fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

FROM browser-libs AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm check が読む lint / format の設定。CI は Docker 内で check を実行するので、ここで渡さないと
# oxlint は shadcn ルールを無言でスキップし、oxfmt はデフォルト設定で判定して format:check が落ちる。
COPY .oxlintrc.json .oxfmtrc.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json

# fd は pi SDK の find ツールが起動する。find は git 管理外でも動くよう --no-require-git (fd 9.0 で追加) を渡す。
# apt の fd-find はベースイメージの追随でこの要件を割る版 (bookworm は 8.6.0) に戻り得るため、
# trixie (fd-find 10.2.0) でも取得方式は変えずリリースバイナリを固定する。test / final の両方で使う。
FROM node:24-trixie-slim AS fd
COPY scripts/install-fd.mjs /tmp/install-fd.mjs
RUN node /tmp/install-fd.mjs /usr/local/bin

FROM manifests AS dependencies
RUN pnpm install --frozen-lockfile
COPY client/ ./client/
COPY server/ ./server/

# 配布セット (chromium-headless-shell + ffmpeg) は dependencies の下流で作る。
# 取得は scripts/install-browser.mjs が playwright-core の CLI に委ね、既にある版は取り直さない。
# `final` はこのステージから /ms-playwright だけを受け取るので、node_modules は持ち込まれない。
FROM dependencies AS browser
COPY scripts/install-browser.mjs ./scripts/install-browser.mjs
RUN node scripts/install-browser.mjs /ms-playwright

# CI: no credentials or live model calls; API tests use a stub runtime.
FROM browser AS test
# Landlock ラッパー (scripts/landlock-exec.py) は python3 で動く。テストの skip に頼らず、
# ビルド時の probe (下の RUN) でラッパーの同梱とカーネルの対応可否を検査する。
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=fd /usr/local/bin/fd /usr/local/bin/fd
# server のテストがルートの scripts/ を読む (dependencies は client/ と server/ しか持たない)
COPY scripts/dev.mjs ./scripts/dev.mjs
COPY scripts/install-landlock.mjs ./scripts/install-landlock.mjs
COPY scripts/landlock-exec.py ./scripts/landlock-exec.py
# shell-quote.mjs は install-browser-cli.mjs と install-landlock.mjs の共有 module (テストも読む)
COPY scripts/shell-quote.mjs ./scripts/shell-quote.mjs
# docs:check は docs / AGENTS.md / README.md / .env.example のリンクとパスを実ファイルと突き合わせる。
# 渡さないと検査対象が空になり、docs のリンク切れを見逃したまま test が通る (final へは入れない)。
COPY docs/ ./docs/
COPY AGENTS.md README.md .env.example ./
COPY scripts/docs-check.mjs ./scripts/docs-check.mjs
# ラッパーが無い / 動かないイメージを出さないための probe。許可 root の外への書き込みが
# EACCES になることまで見る (テスト側の skip 条件ではなくビルドを失敗させる)。
COPY scripts/landlock-exec.py /usr/local/bin/u7agent-landlock
RUN chmod 0755 /usr/local/bin/u7agent-landlock \
    && test "$(/usr/local/bin/u7agent-landlock --abi)" -ge 3 \
    && mkdir -p /tmp/landlock-probe/allowed /tmp/landlock-probe/denied \
    && U7AGENT_LANDLOCK_SHELL=/bin/bash \
       U7AGENT_LANDLOCK_RULES='[{"path":"/tmp/landlock-probe/allowed","create":true},{"path":"/dev/null"}]' \
       /usr/local/bin/u7agent-landlock -c 'echo ok > /tmp/landlock-probe/allowed/written' \
    && test -f /tmp/landlock-probe/allowed/written \
    && ! U7AGENT_LANDLOCK_SHELL=/bin/bash \
         U7AGENT_LANDLOCK_RULES='[{"path":"/tmp/landlock-probe/allowed","create":true},{"path":"/dev/null"}]' \
         /usr/local/bin/u7agent-landlock -c 'echo no > /tmp/landlock-probe/denied/written' 2>/dev/null \
    && test ! -f /tmp/landlock-probe/denied/written \
    && rm -rf /tmp/landlock-probe
# u7agent-browser はサーバー側の CLI を呼ぶ入口。cwd を保つため /app を絶対パスで埋め込む。
COPY scripts/install-browser-cli.mjs ./scripts/install-browser-cli.mjs
RUN node scripts/install-browser-cli.mjs /app /usr/local/bin \
    && test -x /usr/local/bin/u7agent-browser \
    && test -f /app/server/node_modules/tsx/dist/loader.mjs \
    && command -v u7agent-browser >/dev/null
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH}
RUN pnpm check

# ブラウザの probe。root では実行せず、node ユーザー + 既存の Landlock ラッパー経由
# (`u7agent-landlock -c '...'`) + 通常実行相当の許可 root / HOME で実行し、DOM / PNG / ループバックの HTTP と WS /
# ループバック以外と link-local redirect の拒否 / check の分類を検査する (`--self-test`)。
# ラッパー自身 (`shot` / `dom` / `check`) も data: URL と拒否される URL で実行し、
# 入口が動くこと・返すのが cwd 相対パスであること・終了コードと保存の契約をここで見る
# (拒否される URL には長い query を付けて、結果が 1 件あるときも stdout が 64 KiB を超えないことを見る。
#  期限で収集を完走できなかった `check` が検証成功を出さないことも見る。
# テストはブラウザ不在で skip できるので、同梱物の検査は probe 側に持たせる)。
# 環境変数を渡すだけでは Landlock は適用されないため、
# ラッパーが実際に効いていること (ABI 999 は拒否 / 許可 root の外へ書けない) も検査する。2 本同時に走らせて、
# 起動時の回収と同時実行の入場制御が生存中の呼び出しを壊さないことも見る。終了後に残骸が無いことまで見る。
# 2 本目は PLAYWRIGHT_BROWSERS_PATH 未設定で走らせ、import 前に既定 (/ms-playwright) が有効になることも見る。
# `pnpm check` のブラウザテストは root で /tmp/u7agent-browser を作る。probe は node で走るため、
# root 所有の置き場が残っていると mkdir が EACCES になり、実運用の初回起動と条件が変わる。
# 消してから node に作らせ、作成できることまで見る。
RUN rm -rf /tmp/u7agent-browser
USER node
RUN set -eux; \
    mkdir -p /tmp/u7agent-browser-probe; \
    cd /tmp/u7agent-browser-probe; \
    U7AGENT_LANDLOCK_SHELL=/bin/bash; \
    U7AGENT_LANDLOCK_MIN_ABI=3; \
    U7AGENT_LANDLOCK_RULES='[{"path":"/tmp/u7agent-browser-probe","create":true},{"path":"/tmp"},{"path":"/home/node/.cache","create":true},{"path":"/home/node/.npm","create":true},{"path":"/home/node/.local/share/pnpm","create":true},{"path":"/dev/null"},{"path":"/dev/shm"}]'; \
    export U7AGENT_LANDLOCK_SHELL U7AGENT_LANDLOCK_MIN_ABI U7AGENT_LANDLOCK_RULES; \
    wrap() { /usr/local/bin/u7agent-landlock -c "$1"; }; \
    wrap 'u7agent-browser --self-test' > /tmp/u7agent-browser-probe/1.log 2>&1 & p1=$!; \
    wrap 'env -u PLAYWRIGHT_BROWSERS_PATH u7agent-browser --self-test' > /tmp/u7agent-browser-probe/2.log 2>&1 & p2=$!; \
    wait "$p1"; \
    wait "$p2"; \
    cat /tmp/u7agent-browser-probe/1.log /tmp/u7agent-browser-probe/2.log; \
    grep -q "self-test ok" /tmp/u7agent-browser-probe/1.log; \
    grep -q "self-test ok" /tmp/u7agent-browser-probe/2.log; \
    test -z "$(ls -A /tmp/u7agent-browser)"; \
    data_url=data:text/html,entry-probe; \
    wrap "u7agent-browser dom $data_url" > /tmp/u7agent-browser-probe/dom.log 2>&1; \
    grep -q "entry-probe" /tmp/u7agent-browser-probe/dom.log; \
    wrap "u7agent-browser check $data_url" > /tmp/u7agent-browser-probe/check-ok.log 2>&1; \
    grep -q "検証成功" /tmp/u7agent-browser-probe/check-ok.log; \
    wrap "u7agent-browser shot $data_url shot.png" > /tmp/u7agent-browser-probe/shot.log 2>&1; \
    grep -qx "shot.png" /tmp/u7agent-browser-probe/shot.log; \
    test -s shot.png; \
    wrap "u7agent-browser shot $data_url shot.png" > /tmp/u7agent-browser-probe/shot-2.log 2>&1; \
    grep -qx "shot-1.png" /tmp/u7agent-browser-probe/shot-2.log; \
    test -s shot-1.png; \
    ( set +x; long_url="http://192.0.2.1/?q=$(head -c 80000 /dev/zero | tr '\0' x)"; \
      ! wrap "u7agent-browser check '$long_url'" > /tmp/u7agent-browser-probe/check-denied.log 2> /tmp/u7agent-browser-probe/check-denied.err ); \
    grep -q "検証失敗" /tmp/u7agent-browser-probe/check-denied.log; \
    test "$(wc -c < /tmp/u7agent-browser-probe/check-denied.log)" -le 65536; \
    ! wrap "u7agent-browser check data:text/html,hello --deadline-ms 1000" > /tmp/u7agent-browser-probe/check-deadline.log 2>&1; \
    ! grep -q "検証成功" /tmp/u7agent-browser-probe/check-deadline.log; \
    grep -q "期限" /tmp/u7agent-browser-probe/check-deadline.log; \
    ! wrap "u7agent-browser shot http://192.0.2.1/ denied.png" > /tmp/u7agent-browser-probe/shot-denied.log 2>&1; \
    test ! -f denied.png; \
    test -z "$(ls -A /tmp/u7agent-browser)"; \
    ! U7AGENT_LANDLOCK_MIN_ABI=999 wrap 'u7agent-browser --self-test' > /tmp/u7agent-browser-probe/invalid-abi.log 2>&1; \
    cat /tmp/u7agent-browser-probe/invalid-abi.log; \
    grep -q "older than the required" /tmp/u7agent-browser-probe/invalid-abi.log; \
    ! wrap 'echo no > /home/node/landlock-denied-written' 2>/dev/null; \
    echo "landlock: 許可 root の外への書き込みを拒否しました"; \
    test ! -f /home/node/landlock-denied-written; \
    rm -rf /tmp/u7agent-browser-probe
USER root

FROM test AS builder

FROM manifests AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# CD: the existing pipeline builds final and pushes monorepo/u7agent.
# BFF とサンドボックス (src/sandbox/index.ts) は同一イメージを command 差し替えで共用する。
# server/src/ には組み込みスキルの SKILL.md (src/builtin-skills/) も含めて同梱する。
FROM browser-libs AS final
# uv はコンテナ内で Python の依存を .venv に閉じ込めるために使う。apt の RUN にある command -v 検査が uv も見るので、
# この COPY を後ろに置くと検査時に uv が無い。
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /uvx /usr/local/bin/
# curl / jq / file / unzip / xz / zip はサンドボックス内のエージェントが HTTP 取得とアセット検証に使う。
# HTTP の正規手段を curl にして `node -e` のワンライナー fetch へ迂回させないのが目的で、同じ一覧を
# server/src/agent.ts の appendSystemPrompt が名指しする。apt 行から落ちたら command -v 検査でビルドを失敗させる。
# python3 は apt の 3.13 系 (trixie) をプロンプトが名指しする。python3-venv は ensurepip 経路用で、
# pip 自体は入れない (`uv pip install` を正とする)。
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep ca-certificates \
    curl jq file unzip xz-utils zip python3 python3-venv \
    && for tool in bash git rg curl jq file unzip xz zip python3 uv; do command -v "$tool" >/dev/null || exit 1; done \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /session-store && chown node:node /workspace /session-store
# bash の書き込みを許可 root の外へ広げない Landlock ラッパー (server/src/sandbox/landlock.ts)。
# python3 は上の apt で入る。
COPY scripts/landlock-exec.py /usr/local/bin/u7agent-landlock
RUN chmod 0755 /usr/local/bin/u7agent-landlock
COPY --from=fd /usr/local/bin/fd /usr/local/bin/fd
# 配布セットは browser ステージから受ける (app の node_modules は持ち込まない)。
COPY --from=browser /ms-playwright /ms-playwright
ARG COMMIT_HASH=""
ENV COMMIT_HASH=${COMMIT_HASH} \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    SANDBOX_PORT=9418 \
    PI_PREVIEW_PORT=4319 \
    PI_FILE_PREVIEW_PORT=4318 \
    PI_APP_CWD=/workspace \
    PI_SANDBOX_CWD=/workspace \
    PI_SESSION_STORE=/session-store
WORKDIR /app
COPY --from=production-dependencies /app/ ./
COPY --from=builder /app/server/src/ ./server/src/
COPY --from=builder /app/client/dist/ ./client/dist/
# u7agent-browser の入口。tsx と CLI ソースを絶対パスで呼び、呼び出し元の cwd を保つ。
# ブラウザ本体は browser ステージの /ms-playwright から来る。エージェントへ配る一覧 (server/src/agent.ts の
# appendSystemPrompt) が chromium とこの入口を名指しするので、落ちたら command -v 検査でビルドを失敗させる。
COPY scripts/install-browser-cli.mjs /tmp/install-browser-cli.mjs
COPY scripts/shell-quote.mjs /tmp/shell-quote.mjs
RUN node /tmp/install-browser-cli.mjs /app /usr/local/bin \
    && test -x /usr/local/bin/u7agent-browser \
    && test -f /app/server/node_modules/tsx/dist/loader.mjs \
    && command -v u7agent-browser >/dev/null \
    && rm -f /tmp/install-browser-cli.mjs /tmp/shell-quote.mjs
USER node
WORKDIR /app/server
EXPOSE 4317 4318 4319 9418 8080
CMD ["node", "--import", "tsx", "src/index.ts"]
