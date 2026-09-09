# pi agent GUI

`projects/_labs/pi-agent-gui` は、今後の継続開発に向けて検証中の実験プロジェクトです。既存の `projects/aiagent` とは別のアプリで、Dependabotの対象には追加していません。

pi SDK を BFF に埋め込んだ、使い捨て前提の小さなブラウザ GUI です。フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は **Hono + TypeScript**（入力検証は zod）で構築し、client は `hono/client` で型安全に API を呼びます。BFF がプロダクションビルドを配信します。

メッセージを送るとエージェントは**バックグラウンドで動き続けます**。ブラウザを閉じても処理は止まらず、複数の会話（セッション）を並行して進められます。停止は画面の「停止」ボタンまたは API で明示的に行います。

## 起動

Node.js 24 と pnpm 10.34.5 を使用します。`client/` と `server/` は一つのpnpm workspaceとして管理し、このディレクトリでコマンドを実行してください。

### 本番（BFF がビルド済みクライアントを配信）

```bash
pnpm install
pnpm build

# 例: 環境変数で API キーを渡す
export ANTHROPIC_API_KEY=sk-ant-...
pnpm start
```

`pnpm build` で `client/dist/` にプロダクションビルドが生成され、BFF（<http://127.0.0.1:4317>）がそれを配信します。ビルド済みクライアントが無い状態で開くと 503 と案内が表示されます。既存の pi の OAuth 認証や `~/.pi/agent/auth.json` もそのまま使えます。

### 開発（フロントエンドのホットリロード）

```bash
# ターミナル 1: BFF
pnpm dev

# ターミナル 2: Vite 開発サーバー（HMR 付き）
pnpm dev:web
```

ブラウザで <http://localhost:5173> を開きます。`/api` へのリクエストは Vite が BFF（:4317）へプロキシします。

```bash
# 使用モデルを固定する場合
PI_MODEL=anthropic/claude-sonnet-4-5 pnpm start

# 作業ディレクトリやポートを変える場合
PI_APP_CWD=/path/to/project PORT=4318 pnpm start
```

## 使い方

- メッセージ送信は即時に返却され、応答は画面にストリーミングされます。実行中も入力でき、送信したメッセージは待機キューに入り順番に実行されます
- 左サイドバーにセッション一覧が出ます（実行中はドットが点滅）。クリックで切り替え、×で削除できます
- 「新しい会話」でセッションを追加できます。既存の会話は残り、裏で実行中の処理も続きます
- 「停止」で実行中の処理と待機キューを取り消せます
- 「エージェント / スキルを管理」から、指示文を書いたスキルを作成してエージェントに割り当てられます。割り当てたスキルは新しい会話のシステムプロンプトに反映されます
- 管理画面の「インポート」「エクスポート」から、エージェントとスキルの定義を JSON ファイルで入出力できます
- 画面右上のスイッチャーでテーマを切り替えられます。6 プリセット（ミッドナイト / デイライト / モカ / フォレスト / サクラ / ターミナル）とシステム追従から選択でき、選択はブラウザに保存されます
- PC とスマートフォンの両方に対応しています。長い会話や設定画面はそれぞれの領域内でスクロールします

セッションとエージェント/スキル定義はメモリ内だけで保持し、サーバー再起動でサンプルに戻ります。

エージェントには `read / bash(or powershell) / edit / write / grep / find / ls` を渡しています。ローカルの作業ディレクトリでコマンド実行・ファイル変更を行えるため、信頼できる環境だけで使ってください。

## 構成

- `server/`: BFF（Hono + TypeScript）。`src/app.ts` がルーティング / SSE / 静的配信と `AppType` export、`src/schema.ts` が zod スキーマと DTO 型（API 契約の正）、`src/sessions.ts` がセッションとラン（非同期実行）、`src/agent.ts` が pi SDK ランタイム生成、`src/agents.ts` がエージェント定義とスキル割り当て
- `client/`: チャット UI（Vite + React 19 + TypeScript + Tailwind CSS v4）。`pnpm build` で `client/dist/` にビルドされ、BFF が配信する。`src/api.ts` は hc 型安全クライアント
- `server/test/`: node:test（pi はスタブで実 API を呼ばない）

## ドキュメント

- [AGENTS.md](AGENTS.md) — エージェント向けの最小ガイド
- [docs/architecture.md](docs/architecture.md) — 非同期実行とセッション管理の設計
- [docs/api.md](docs/api.md) — HTTP API リファレンス（SSE イベント定義を含む）
- [docs/migration.md](docs/migration.md) — 移植元・履歴保存・CI対応の変更点

## Docker / CI・CD

モノレポのPR CIは `test` ステージで型チェック、スタブを用いた12件のテスト、フロントエンドビルドを実行します。専用のlinterはまだ導入していません。mainへのマージ後は既存CDが `final` ステージをビルドし、次のイメージをGHCRへpushします（自動デプロイは行いません）。`final` のビルドも `test` を経由します。

```text
ghcr.io/u7chan/monorepo/pi-agent-gui:latest
```

このプロジェクトのディレクトリでローカル検証できます。

```bash
docker build --target test --build-arg COMMIT_HASH="$(git rev-parse --short HEAD)" .
docker build --target final --build-arg COMMIT_HASH="$(git rev-parse --short HEAD)" -t pi-agent-gui:local .
docker run --rm --init -p 127.0.0.1:4317:4317 pi-agent-gui:local
```

ブラウザで <http://127.0.0.1:4317> を開きます。認証なしでも画面・`/api/health`・エージェント定義を確認できますが、実際のモデル実行には認証が必要です。テストやイメージビルドにAPIキーは不要です。

作業ディレクトリとAPIキーを渡す例:

```bash
# ANTHROPIC_API_KEY は事前にホストの環境変数へ設定する
docker run --rm --init -p 127.0.0.1:4317:4317 \
  -e ANTHROPIC_API_KEY \
  --mount type=bind,src=/absolute/path/to/workspace,dst=/workspace \
  pi-agent-gui:local
```

- **ログイン認証を備えたWebサービスではありません。インターネットやLANへ直接公開しないでください。** コンテナ内は `HOST=0.0.0.0` ですが、ホストの公開先は必ず `127.0.0.1` に限定します。
- 非rootの `node` ユーザー（UID/GID 1000）で動きます。mount先はこのユーザーが読み書きできる権限にしてください。アプリ本体は書き換えできず、既定の作業先は `/workspace` です。
- エージェントはmount先のファイル変更やbash実行ができます。Docker socket、ホーム全体、不要な秘密情報はmountしないでください。
- APIキーやOAuth認証ファイルをイメージへ焼き込まないでください。OAuthを使う場合は専用の認証領域を実行時に渡し、更新時の書込みも考慮してください。ホストの `~/.pi` は自動共有されません。
- Bash、Git、ripgrep、Node.jsを同梱しています。任意の開発環境が揃っているわけではありません。必要なツールは用途に合わせて追加してください。
- セッションとエージェント／スキル定義はメモリ内のみで、コンテナを再起動すると消えます。必要な定義は画面からエクスポートしてください。

CDの仕組みは [モノレポのCI/CD](../../../docs/about-cicd.md) を参照してください。
