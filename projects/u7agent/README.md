# u7agent

pi SDK を BFF に埋め込んだ小さなブラウザ GUI（`projects/u7agent`）。client は Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は Hono + TypeScript で、client は `hono/client` で型安全に API を呼びます。セッションは BFF 専用の会話ストア（`PI_SESSION_STORE`）へ保存され、再起動後も一覧・履歴・続きの送信を復元できます。エージェント/スキル定義とプロジェクトはアプリデータの SQLite（`<PI_SESSION_STORE>/u7agent.db`）へ保存され、再起動後も残ります。

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

モデルの `write` / `edit` は、そのセッションの作業ディレクトリ配下と、共通スキル置き場 `<workspace root>/.agents/skills` 配下にだけ書けます。未所属チャットで `<workspace root>` 直下を指す絶対パスを書こうとした取り違えもここで拒否され、`cafe.html` のような cwd 相対パスで再試行できます。`bash` のリダイレクトは塞げないため、これは隔離ではなくファイルツールのポリシーです（`git worktree add` しただけの未登録ディレクトリも書き込み範囲外で、登録したプロジェクトのセッションでないと書けません）。詳細は [docs/projects.md](docs/projects.md#write--edit-の書き込み範囲)。

チャットの添付は、所属に関係なく `<workspace root>/.u7agent/uploads/<sessionId>/` に保存します。エージェントには注記で絶対パスを渡し、ファイル画面には出しません。`<workspace root>/.u7agent` 配下はプロジェクトとして登録できません（400）。

## スキル

スキルは 3 種類あります。

- **エージェント定義のスキル**（設定 → スキル）— エージェントへ割り当てる指示。アプリデータの SQLite に保存され、再起動後も残ります
- **ファイルスキル** — `<PI_APP_CWD>/.agents/skills/<name>/SKILL.md`（共通）と、プロジェクト配下の `<project>/.agents/skills/<name>/SKILL.md`（そのプロジェクトのセッションのみ）。エージェントに紐づかない ambient なスキルとしてセッションへ注入され、モデルは必要になった時点で `SKILL.md` を `read` します（本文の編集は次に読んだ時点から効きます）
- **組み込みスキル** — アプリに同梱した `skill-creator` など（`server/src/builtin-skills/`）。全セッションで常時有効で、ワークスペースには実体を作らず、`read` だけ BFF が同梱の本文を返します。編集の対象外です

共通スキルの置き場はワークスペース root（`PI_APP_CWD`）の直下です。ローカル dev の既定は `projects/u7agent` 自身なので、モノレポ root の `.agents/skills` を使いたい場合は `PI_APP_CWD=/path/to/monorepo pnpm dev` のように指定します（サンドボックスの `PI_SANDBOX_CWD` と同じパスに揃えてください）。共通スキルと組み込みスキルは設定 → スキルで読み取り専用で確認できます（組み込みは本文ビュー付き）。

チャットの入力欄の「スキル一覧」から、そのセッションで使えるスキル（プロジェクト / 共通 / 組み込み / エージェント定義）を選んで `/skill:<name>` を入力できます。`/skill:` は送信時に BFF が本文ブロックへ展開するため、Docker（BFF に作業領域が無い）でもファイルスキルと組み込みスキルが動きます。本文は送信時点の内容で、一覧が固定するのは発見一覧・説明・優先順位だけです。詳細は [docs/persistence.md](docs/persistence.md#スキルの扱い) と [docs/api-catalog.md](docs/api-catalog.md#ファイルスキルagentsskills)、展開の仕様は [docs/api-sessions.md](docs/api-sessions.md#skill-の展開) を参照してください。

## 環境変数

| 変数 | 説明 |
| --- | --- |
| `PI_APP_CWD` | ワークスペース root（登録したプロジェクトと未所属チャットのスクラッチの起点、および共通スキル `<PI_APP_CWD>/.agents/skills` の場所。既定: このディレクトリ） |
| `PI_SESSION_STORE` | 会話ストアの絶対パス（既定: `<pi agentDir>/u7agent/sessions`）。ワークスペースの外を指定する。未設定でも起動するが、`null`（永続化なし）にしたいのはテストだけ |
| `PI_MODEL` / `PI_MODELS` | 既定モデルの固定 / 選択できるモデルの whitelist |
| `PI_THINKING` | 既定の Effort |
| `PORT` / `HOST` | BFF の待受（既定 4317 / 127.0.0.1） |
| `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` | 外部のサンドボックスへ繋ぐ場合のみ（`pnpm dev` は自動で設定） |
| `PI_SECRET_ENV_VARS` | 追加でマスクする独自の秘密環境変数 |

一覧は [.env.example](.env.example) と [docs/sandbox-api.md](docs/sandbox-api.md)（サンドボックス側）を参照してください。

プロジェクトとエージェント / スキル定義は、会話ストアと同じディレクトリの `u7agent.db`（SQLite）に保存します。パスを分ける環境変数はなく、`PI_SESSION_STORE` を永続ボリュームに置けば両方残ります（[persistence.md](docs/persistence.md)）。

## セキュリティ

- **ログイン認証はありません。インターネットや LAN へ公開しないでください**（既定の待受は `127.0.0.1`）
- ツールはサンドボックスの作業領域でコマンド実行やファイル変更ができます。信頼できる環境だけで使ってください（`write` / `edit` はセッションの作業ディレクトリと `<workspace root>/.agents/skills` に限られますが、`bash` は制限しません）
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
