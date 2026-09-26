# ツール実行のサンドボックス分離

作業用ツール（read / bash / edit / write / grep / find / ls）は BFF プロセス内では実行しない。pi SDK の `customTools` で同名の組み込みツールを「サンドボックス実行APIを呼ぶリモート定義」で置き換え、BFF が任意の作業コードを実行する経路を無くす。この分離はコンテナ構成を前提とし、そこでは LLM 認証情報は BFF だけが保持し、サンドボックスのプロセス・環境変数・ファイルシステムには渡らない（ホスト上の別プロセスとして起動する場合は同一ユーザー・同一環境になるため、[残存リスク](#残存リスク)の制約を受ける）。

HTTP 契約と環境変数は [sandbox-api.md](sandbox-api.md)、APIキーのマスクは [secrets.md](secrets.md) を参照する。

## 構成

```
pi SDK (BFF)                       sandbox service (別プロセス / 別コンテナ)
  customTools (remote-tools.ts)         service.ts: SDK 組込みツールをローカル実行
   ├ execute() プロキシ  ── Bearer ──▶  POST /v1/tools/:tool/execute (NDJSON)
   ├ onUpdate ◀──── update イベント      (onUpdate を relay)
   └ result / error ◀── result / error   POST /v1/executions/:id/cancel
```

- `remote-tools.ts`: ツールのメタデータ（名前・説明・TypeBox スキーマ）はローカルで生成した SDK 組込み定義から借り、`execute` だけを差し替える。grep / find が BFF ローカルで rg / fd を起動しないよう、検索プロセスも含めてすべてサンドボックス側で完結する。未知のツール名（`powershell` など）は設定ミスとして例外にする
- `service.ts`: SDK のローカルツール実装を実ファイルシステムに対して実行し、NDJSON（`start` / `update` / `result` / `error`）で応答する。bash は `exposeSessionEnvironment: false` で生成しセッションメタ変数を子プロセスへ注入しない。さらに `spawnHook` で `PI_SANDBOX_TOKEN` を子プロセスの env から剥がす（サンドボックス内の唯一の秘密値がツール出力へ現れないようにする）
- `client.ts`: ストリームを解釈して SDK の `execute()` 契約（`onUpdate` / 最終結果 / abort）へ写し替える。abort は cancel エンドポイント（専用タイムアウト付き signal で送信。実行IDが判明後）と接続切断の両方でサンドボックスへ伝播し、サンドボックス側は SDK ツールの `AbortSignal` で子プロセスを殺す

## 認証と到達性

- すべての `/v1/*` は `Authorization: Bearer PI_SANDBOX_TOKEN` を要求し、長さを漏らさない定数時間比較で検証する。未認証は 401
- `/healthz` は無認証（Compose healthcheck 用）。ツール実行の情報は含まない
- 実行環境の診断（`GET /v1/runtime/info`）も同じ認証の下に置く。診断の子プロセスは bash ツールの `spawnHook` を通らないため、環境を新規作成し、信頼ディレクトリで解決した絶対パスと固定引数だけを実行し、期限・同時数・出力上限を設ける（[sandbox-api.md](sandbox-api.md#検出の安全性と上限)）
- ツール実行APIはホストへ publish しない。BFF ⇄ サンドボックスは専用の内部ネットワークのみで到達する。トークンは BFF とサンドボックスの 2 サービスにのみ渡す（LLM 認証情報とは別の値）。ホスト上の別プロセスで起動する場合は `SANDBOX_HOST=127.0.0.1` を指定する（既定は `0.0.0.0` で LAN へ露出する）
- サンドボックス内で起動したサーバー（Python / Node の dev server など）はホストへ publish されず、BFF にも任意ポートの proxy が無いため、ブラウザ・ホストのどちらからも到達できない。エージェント自身の確認はサンドボックス内の `curl 127.0.0.1:<port>` までで、成果物を人間に見せる経路はファイルプレビュー（`GET /api/files/preview` / `/api/files/html/<root 相対>` / `/api/files/raw`）だけ（HTML プレビューの CSP は `default-src 'none'` で `connect-src` を持たず、プレビューからサーバーへも繋げない）
- `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定のとき、BFF はセッション作成を 503 で拒否する（ローカル実行へのフォールバックなし）

## パスと並行実行

- BFF のワークスペース root（`PI_APP_CWD=/workspace`）とサンドボックスの作業領域 root（`PI_SANDBOX_CWD=/workspace`）を同じコンテナ内パスに揃え、パス変換なしでサンドボックス側へ解決させる。セッションごとの作業ディレクトリは root 相対で渡し、サンドボックスが root と結合して実パスにする（[projects.md](projects.md)）。作業領域の永続マウントはサンドボックスだけへ付け、BFF には付けない
- `..` の適用順はカーネル（symlink を辿ってから `..`）に合わせ、lexical な畳み込みはしない。root 内外の判定は realpath で解決した実パスで行う
- `write` / `edit` はセッションの作業ディレクトリと `<root>/.agents/skills` の内側だけに書ける。ツール定義（実行 cwd）に加えて要求 cwd の lexical 形を許可 root に焼き込み、SDK が解決した絶対パスを `resolve()` で `..` まで畳んで比較する（realpath / `lstat` は使わない）。拒否は 200 の `error` イベントで返す（HTTP 400 の JSON ラッパーをモデルに見せない）。`read` / `grep` / `find` / `ls` / `bash` は制限しない。これはモデルの取り違えを防ぐファイルツールのポリシーで、`bash` のリダイレクトは塞げない（[projects.md](projects.md#write--edit-の書き込み範囲)）
- 実行は toolCallId / executionId 単位で独立し、複数セッションの並行実行でも要求と出力が混線しない。ブラウザ切断はランに影響せず、明示停止（`POST /stop` → `session.abort()`）だけが対象のツール実行を中断する

## 配布イメージと起動契約

- イメージは BFF とサンドボックスで共用し、`command` だけ差し替える（`node --import tsx src/sandbox/index.ts`）。CD（`final` ステージ）の単一イメージ前提を維持する
- イメージには bash / git / ripgrep / fd を事前搭載する。ripgrep・fd はサンドボックス内で必要。fd は pi SDK の find ツールが渡す `--no-require-git`（fd 9.0 で追加）を満たす必要があり、apt の fd-find はベースイメージの追随で要件を割る版（bookworm は 8.6.0）に戻り得るため、`scripts/install-fd.mjs` でリリースバイナリ（sha256 固定）を `test` / `final` の両ステージへ入れる（trixie の fd-find は 10.2.0 で条件を満たすが、取得方式は変えていない）
- HTTP 取得とアセット検証用に curl / jq / file / unzip / xz / zip も入れる。curl を正規手段にして `node -e` のワンライナー fetch へ迂回させないのが目的で、この一覧は `server/src/agent.ts` の `appendSystemPrompt` が名指しする。apt 行から落ちた場合は `final` ステージの `command -v` 検査でビルドが失敗する
- Python は 3.13 系（ベース `node:24-trixie-slim` の apt `python3`。実測 3.13.5）と uv（`ghcr.io/astral-sh/uv:0.12.18` から `/uv` / `/uvx` を COPY）を入れる。`python3-pip` は入れない — pip が要るのは `uv venv --seed` か `python3 -m venv` の ensurepip だけで、uv の経路は `uv pip install --python .venv/bin/python` で完結する。`command -v` 検査は uv を COPY した後の apt の RUN にあり、`python3` と `uv` も見る
- Python の依存は**作業ディレクトリ直下の `.venv`** に入れる。イメージ内の `/home/node` はコンテナのレイヤに属し、永続マウントは `/workspace`（と会話ストア）にしかないため、`~/.local` や `uv tool` の既定先に置いた依存は再作成で消える。`.venv` は作成時の絶対パスを内部に持つので、同じイメージ・同じマウント先・同じ絶対パスなら再作成後もそのまま使える（`uv venv` の既定は system Python を使い、`pyvenv.cfg` の `home` は apt の `/usr/bin` を指す）。ただし venv の運用は `appendSystemPrompt` の方針で、`~/.local` / `--target` / `--prefix` への導入は技術的に防いでいない（[残存リスク](#残存リスク)）
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動く。ホスト側の永続領域実パス・所有権・Compose 構成はデプロイ側リポジトリ（self-hosted-runner）で管理する（[persistence.md](persistence.md)）

## 残存リスク

- 非rootコンテナ・別プロセスは完全な隔離ではない。同一ユーザーのサンドボックス内では会話間のセキュリティ分離はなく、ファイル・ポート・Git の共有情報は競合し得る
- ホスト上の別プロセスとして起動したサンドボックスは BFF と同一ユーザー・同一環境になる。親シェルから export した APIキーは継承され、同一ユーザーが読める認証ファイル（`~/.pi/agent/auth.json` など）も読める。この構成の分離はプロセス分離であり、コンテナ分離ではない
- サンドボックスから外向きの通信は制限していない。ツールで実行したコードはネットワークへ到達できる。ネットワーク制限・リソース上限の具体値はデプロイ側の運用に委ねる
- ユーザーが作業領域へ置いたファイルの内容はツールから読める。認証情報を作業領域へ置かない運用とする
- `write` / `edit` の書き込み範囲はファイルツールのポリシーで、実行隔離ではない。同じファイルへ `bash` からは書ける。判定が lexical のため、作業領域内に置かれた symlink 経由の脱出（既存・壊れたリンクとも）も検知しない（親ディレクトリを作る `mkdir` はポリシー判定を通すので、拒否パスに親はできない）
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされないが、それを読むツール出力はマスクされる（[secrets.md](secrets.md)）
