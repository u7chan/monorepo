# pi agent GUI

pi SDK を BFF に埋め込んだ小さなブラウザ GUI（`projects/pi-agent-gui`）。client は Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は Hono + TypeScript で、client は `hono/client` で型安全に API を呼びます。セッションとエージェント/スキル定義はメモリ内のみで、再起動すると消えます。

メッセージ送信は即時に返り、エージェントはバックグラウンドで動き続けます（ブラウザを閉じても継続）。作業用ツール（read / bash / edit / write / grep / find / ls）は BFF から分離したサンドボックスプロセスで実行します。

## ローカルで起動する（Docker なし）

Node.js 24 と pnpm 10.34.5 を使います。初回だけ `pnpm install`。

```bash
pnpm dev   # サンドボックス + BFF + Vite をまとめて起動 → http://localhost:5173
```

- サンドボックスは常に別プロセスです。`pnpm dev` が共有トークンを生成してサンドボックスと BFF の両方へ渡します（ローカルで Docker は不要）
- 作業領域は既定でこのディレクトリです。変えるときは `PI_APP_CWD=/path/to/project pnpm dev`（プロジェクトと未所属チャットの起点になります）
- APIキーは `cp .env.example .env` で設定できます。`~/.pi/agent/auth.json` があれば不要です（`.env` を読むのは BFF だけ）
- 停止は Ctrl-C（3 プロセスまとめて止まります）

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `PI_APP_CWD` | ワークスペース root（プロジェクトと未所属チャットの起点。既定: このディレクトリ） |
| `PI_MODEL` / `PI_MODELS` | 既定モデルの固定 / 選択できるモデルの whitelist |
| `PI_THINKING` | 既定の Effort |
| `PORT` / `HOST` | BFF の待受（既定 4317 / 127.0.0.1） |
| `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` | 外部のサンドボックスへ繋ぐ場合のみ（`pnpm dev` は自動で設定） |
| `PI_SECRET_ENV_VARS` | 追加でマスクする独自の秘密環境変数 |

一覧は [docs/api.md](docs/api.md) の環境変数表と [.env.example](.env.example) を参照してください。

## セキュリティ

- **ログイン認証はありません。インターネットや LAN へ公開しないでください**（既定の待受は `127.0.0.1`）
- ツールはサンドボックスの作業領域でコマンド実行やファイル変更ができます。信頼できる環境だけで使ってください
- LLM の APIキーは BFF が持ち、サンドボックスへは共有トークンしか渡しません。ツール出力に現れた既知のキーは、LLM・SSE・ログへ渡す前に `[REDACTED]` へ置換します。ただし `pnpm dev` のようにホストで別プロセスとして起動した場合、サンドボックスは起動元シェルの環境を継承するため、export 済みの APIキーと同一ユーザーが読める認証ファイルは見えます（コンテナ分離ではこの継承はありません）
- `pnpm dev` の分離はプロセス分離です（同一ユーザー・同一環境）。コンテナ分離の設計と残存リスクは [docs/architecture.md](docs/architecture.md) を参照してください

## ドキュメント

- [AGENTS.md](AGENTS.md) — エージェント向けの最小ガイド（検証コマンド・コメント方針）
- [docs/architecture.md](docs/architecture.md) — 非同期実行・サンドボックス分離・APIキー保護の設計
- [docs/api.md](docs/api.md) — HTTP API リファレンス（環境変数表・SSE イベント）
- [docs/persistence.md](docs/persistence.md) — 永続化される範囲と再デプロイ時の挙動
- [docs/ui-layout.md](docs/ui-layout.md) — レイアウトモードの判定
- [docs/migration.md](docs/migration.md) — 移植元・履歴保存・CI対応の変更点

配布イメージは main マージ後の CD が GHCR（`ghcr.io/u7chan/monorepo/pi-agent-gui:latest`）へ push します。CD の仕組みは [モノレポのCI/CD](../../docs/about-cicd.md) を参照してください。
