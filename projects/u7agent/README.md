# u7agent

pi SDK を BFF に埋め込んだ小さなブラウザ GUI（`projects/u7agent`）。client は Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は Hono + TypeScript で、client は `hono/client` で型安全に API を呼びます。セッションは BFF 専用の会話ストア（`PI_SESSION_STORE`）へ保存され、再起動後も一覧・履歴・続きの送信を復元できます。エージェント/スキル定義はメモリ内のみで、再起動すると消えます。

メッセージ送信は即時に返り、エージェントはバックグラウンドで動き続けます（ブラウザを閉じても継続）。作業用ツール（read / bash / edit / write / grep / find / ls）は BFF から分離したサンドボックスプロセスで実行します。

## ローカルで起動する（Docker なし）

Node.js 24 と pnpm 10.34.5 を使います。初回だけ `pnpm install`。

```bash
pnpm dev   # サンドボックス + BFF + Vite をまとめて起動 → http://localhost:5173
```

- サンドボックスは常に別プロセスです。`pnpm dev` が共有トークンを生成してサンドボックスと BFF の両方へ渡します（ローカルで Docker は不要）
- 作業領域は既定でこのディレクトリです。変えるときは `PI_APP_CWD=/path/to/project pnpm dev`（プロジェクト登録と未所属チャットの起点になります）
- APIキーは `cp .env.example .env` で設定できます。`~/.pi/agent/auth.json` があれば不要です（`.env` を読むのは BFF だけ）
- 停止は Ctrl-C（3 プロセスまとめて止まります）

## プロジェクトとセッションの作業ディレクトリ

登録したプロジェクトに所属するセッションは、その登録ディレクトリを cwd にして動きます（SDK セッション・ツールのパス解決・ファイル画面が同じディレクトリ）。同一プロジェクトの複数セッションはツリーを共有するため、片方で作ったファイルが他方からも見え、`git status` や `git worktree add` のようなリポジトリ前提の作業ができます。未所属チャットは `<workspace root>/.u7agent/sessions/<id>` のスクラッチで動きます。worktree はアプリが作らないので、並行作業は切った worktree をプロジェクトとして登録して分離します。詳細は [docs/projects.md](docs/projects.md)。

チャットの添付は、所属に関係なく `<workspace root>/.u7agent/uploads/<sessionId>/` に保存します。エージェントには注記で絶対パスを渡し、ファイル画面には出しません。`<workspace root>/.u7agent` 配下はプロジェクトとして登録できません（400）。

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `PI_APP_CWD` | ワークスペース root（登録したプロジェクトと未所属チャットのスクラッチの起点。既定: このディレクトリ） |
| `PI_SESSION_STORE` | 会話ストアの絶対パス（既定: `<pi agentDir>/u7agent/sessions`）。ワークスペースの外を指定する。未設定でも起動するが、`null`（永続化なし）にしたいのはテストだけ |
| `PI_MODEL` / `PI_MODELS` | 既定モデルの固定 / 選択できるモデルの whitelist |
| `PI_THINKING` | 既定の Effort |
| `PORT` / `HOST` | BFF の待受（既定 4317 / 127.0.0.1） |
| `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` | 外部のサンドボックスへ繋ぐ場合のみ（`pnpm dev` は自動で設定） |
| `PI_SECRET_ENV_VARS` | 追加でマスクする独自の秘密環境変数 |

一覧は [.env.example](.env.example) と [docs/sandbox-api.md](docs/sandbox-api.md)（サンドボックス側）を参照してください。

## セキュリティ

- **ログイン認証はありません。インターネットや LAN へ公開しないでください**（既定の待受は `127.0.0.1`）
- ツールはサンドボックスの作業領域でコマンド実行やファイル変更ができます。信頼できる環境だけで使ってください
- LLM の APIキーは BFF が持ち、サンドボックスへは共有トークンしか渡しません。ツール出力に現れた既知のキーは、LLM・SSE・ログへ渡す前に `[REDACTED]` へ置換します。ただし `pnpm dev` のようにホストで別プロセスとして起動した場合、サンドボックスは起動元シェルの環境を継承するため、export 済みの APIキーと同一ユーザーが読める認証ファイルは見えます（コンテナ分離ではこの継承はありません）
- `pnpm dev` の分離はプロセス分離です（同一ユーザー・同一環境）。コンテナ分離の設計と残存リスクは [docs/sandbox.md](docs/sandbox.md) を参照してください

## ドキュメント

- [AGENTS.md](AGENTS.md) — エージェント向けの最小ガイド（検証コマンド・コメント方針）
- [docs/README.md](docs/README.md) — 変更テーマ別の索引（ここから必要なドキュメントだけを辿る）
- [docs/architecture.md](docs/architecture.md) — 層構成・基本原則・責務の所在
- [docs/run-lifecycle.md](docs/run-lifecycle.md) — 非同期実行・キュー・SSE・セッションのライフサイクル
- [docs/sandbox.md](docs/sandbox.md) — サンドボックス分離の設計（[sandbox-api.md](docs/sandbox-api.md) に API 契約）
- [docs/secrets.md](docs/secrets.md) — APIキー保護
- [docs/api.md](docs/api.md) — HTTP API の規約と索引（[api-sessions.md](docs/api-sessions.md) / [api-catalog.md](docs/api-catalog.md)）
- [docs/persistence.md](docs/persistence.md) — 永続化される範囲と再デプロイ時の挙動
- [docs/ui-layout.md](docs/ui-layout.md) — レイアウトモードの判定
- [docs/migration.md](docs/migration.md) — 移植元・履歴保存・CI対応の変更点

配布イメージは main マージ後の CD が GHCR（`ghcr.io/u7chan/monorepo/u7agent:latest`）へ push します。CD の仕組みは [モノレポのCI/CD](../../docs/about-cicd.md) を参照してください。
