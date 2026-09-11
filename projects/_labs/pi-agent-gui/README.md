# pi agent GUI

`projects/_labs/pi-agent-gui` は、今後の継続開発に向けて検証中の実験プロジェクトです。既存の `projects/aiagent` とは別のアプリで、Dependabotの対象には追加していません。

pi SDK を BFF に埋め込んだ、使い捨て前提の小さなブラウザ GUI です。フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は **Hono + TypeScript**（入力検証は zod）で構築し、client は `hono/client` で型安全に API を呼びます。BFF がプロダクションビルドを配信します。

メッセージを送るとエージェントは**バックグラウンドで動き続けます**。ブラウザを閉じても処理は止まらず、複数の会話（セッション）を並行して進められます。停止は画面の「停止」ボタンまたは API で明示的に行います。

作業用ツール（ファイル操作・シェル・検索）は **BFF から分離されたサンドボックスサービス**で実行されます。LLM 認証情報は BFF だけが持ち、サンドボックス側のプロセス・環境変数・ファイルシステムには渡りません。

## 起動

Node.js 24 と pnpm 10.34.5 を使用します。`client/` と `server/` は一つのpnpm workspaceとして管理し、このディレクトリでコマンドを実行してください。

### 本番（BFF がビルド済みクライアントを配信）

```bash
pnpm install
pnpm build

# API キーを設定（プロジェクト直下の .env は start/dev から自動で読み込まれます）
cp .env.example .env
# .env の ANTHROPIC_API_KEY（または利用するプロバイダーのキー）を編集する
pnpm start
```

`pnpm build` で `client/dist/` にプロダクションビルドが生成され、BFF（<http://127.0.0.1:4317>）がそれを配信します。ビルド済みクライアントが無い状態で開くと 503 と案内が表示されます。既存の pi の OAuth 認証や `~/.pi/agent/auth.json` もそのまま使えます。

APIキーが未設定でも画面は起動しますが、送信はできません。画面に表示される案内に従って `.env` を設定し、サーバーを再起動してください。

### 開発（フロントエンドのホットリロード）

```bash
# ターミナル 1: サンドボックス（ツール実行サービス）。PI_SANDBOX_CWD は書込み可能なディレクトリを指定
PI_SANDBOX_TOKEN=dev-shared-token-change-me PI_SANDBOX_CWD=$PWD pnpm start:sandbox

# ターミナル 2: BFF（PI_APP_CWD をサンドボックスの作業領域と同じパスへ）
PI_SANDBOX_URL=http://127.0.0.1:8080 PI_SANDBOX_TOKEN=dev-shared-token-change-me PI_APP_CWD=$PWD pnpm dev

# ターミナル 3: Vite 開発サーバー（HMR 付き）
pnpm dev:web
```

ブラウザで <http://localhost:5173> を開きます。`/api` へのリクエストは Vite が BFF（:4317）へプロキシします。

BFF は `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が無い場合、セッション作成時に明示エラーになります。BFF はツールをローカル実行へフォールバックしないため、開発時もサンドボックスの起動が必要です。サンドボックスの既定作業領域はイメージ契約どおり `/workspace` ですが、ホストで起動するときは `PI_SANDBOX_CWD` に書込み可能なディレクトリを指定し、BFF の `PI_APP_CWD` を同じパスに揃えてください（BFF とサンドボックスでパス解決を一致させる）。

```bash
# 使用モデルを固定する場合
PI_MODEL=anthropic/claude-sonnet-4-5 pnpm start

# 推論の強さ（Effort）を既定で変える場合
PI_THINKING=high pnpm start

# 作業ディレクトリやポートを変える場合
PI_APP_CWD=/path/to/project PORT=4318 pnpm start
```

`PI_MODEL` に指定したモデルが認証済みの候補に無い場合は、別のモデルへ黙って切り替えず、画面の Model 選択にエラーとして表示します。利用できるモデルを入力欄から選べばそのまま使えます。

## 使い方

- メッセージ送信は即時に返却され、応答は画面にストリーミングされます。実行中も入力でき、送信したメッセージは待機キューに入り順番に実行されます
- 左サイドバーにセッション一覧が出ます（実行中はドットが点滅）。クリックで切り替え、×で削除できます
- 「新しい会話」でセッションを追加できます。既存の会話は残り、裏で実行中の処理も続きます
- 「停止」で実行中の処理と待機キューを取り消せます
- ツール呼び出しの履歴は回答前にまとめて省略表示され、クリックすると各ツールの引数と出力を確認できます（既定は折りたたみ）
- 「エージェント / スキルを管理」から、指示文を書いたスキルを作成してエージェントに割り当てられます。割り当てたスキルは新しい会話のシステムプロンプトに反映されます
- 入力欄の上にある Model / Effort で、その会話のモデルと推論の強さをいつでも切り替えられます。同じ会話・履歴・タイトルを保ったまま変わり、他の会話には影響しません。変更中はピッカーと送信が一時的に無効になります
- 画面右上のモデル表示は、選択中の会話が実際に使うモデルを「会話」、未作成のときのアプリ既定モデルを「既定」として区別して表示します。リロード後や会話を切り替えた後も、会話の表示は選択中セッションの実効値に一致します
- エージェントの管理画面では、そのエージェントで新しい会話を始めるときの Model / Effort を「未指定」込みで指定できます。未指定の項目はアプリ既定が使われます。定義の変更は既存の会話に遡及しません
- 管理画面の「インポート」「エクスポート」から、エージェントとスキルの定義を JSON ファイルで入出力できます
- 画面右上のスイッチャーでテーマを切り替えられます。6 プリセット（ミッドナイト / デイライト / モカ / フォレスト / サクラ / ターミナル）とシステム追従から選択でき、選択はブラウザに保存されます
- PC とスマートフォンの両方に対応しています。長い会話や設定画面はそれぞれの領域内でスクロールします

セッションとエージェント/スキル定義はメモリ内だけで保持し、サーバー再起動でサンプルに戻ります。

エージェントには `read / bash / edit / write / grep / find / ls` を渡しています。これらはすべてサンドボックスサービス内で実行され、BFF プロセスは任意の作業コードを実行しません。サンドボックスの作業領域でコマンド実行・ファイル変更を行えるため、信頼できる環境だけで使ってください。

## APIキーの保護

LLM 認証情報は BFF だけが保持し、ツール実行は認証付きの別サービス（サンドボックス）へ分離しています。

- **実行の分離**: read / bash / edit / write / grep / find / ls のすべての作業用ツールは、BFF とは別プロセス（デプロイ時は別コンテナ）のサンドボックスサービスで実行されます。BFF はツール引数を認証付きAPIへ中継するだけで、任意の作業コードを BFF 上で実行しません。bash・ripgrep・fd はサンドボックス側で動きます
- **認証情報の非共有**: サンドボックスのプロセス・環境変数・ファイルシステムには LLM 認証情報を渡しません。ツール実行APIの認証には専用の共有トークン（`PI_SANDBOX_TOKEN`）を使い、これは LLM 認証情報とは別の値です。APIはホストへ公開せず、BFF からの要求だけを受け付け、未認証要求は 401 で拒否します
- **対象のマスク**: pi が認証に使う既知の環境変数（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` など。pi-ai のプロバイダー解決に追従し、`AWS_BEARER_TOKEN_BEDROCK` のような解決外のキー変数も補完）の非空値。独自プロバイダーのキーは `PI_SECRET_ENV_VARS` で追加します（明示指定した変数は値の長さに関係なく保護。自動解決分は 8 文字未満を通常出力の過剰改変防止のため対象外とします）。AWS の IAM 認証情報（`AWS_ACCESS_KEY_ID` など）と OAuth トークンは対象外です
- **ツール出力のマスク**: ツールの途中出力・最終出力・エラーに既知のキーが現れた場合、LLM・SSE・ログのいずれへも渡る前に `[REDACTED]` へ置換します。シェル以外のツール（read / grep など）の出力も対象です。ストリーミングではキーがチャンク境界をまたいでも生の値が現れないよう、前方一致になり得る末尾を保留してから配信します。SDKが出力を末尾Nバイトへ切り詰めることでキーの先頭が欠けた場合、また grep が一致行を500文字へ切り詰めることでキーの末尾が欠けた場合も、部分一致（4 文字以上）を置換します

### 保証しないこと（残存リスク）

- 非rootコンテナ・別プロセス分離は完全な隔離ではありません。同一ユーザーのサンドボックス内では、会話間のセキュリティ分離はありません。ファイル・ポート・Git の共有情報は競合し得ます
- サンドボックスから外向きの通信は制限していません。ツールで実行したコードはネットワークへ到達できます（ネットワーク制限・リソース上限はデプロイ側の運用に委ねます）
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれます。ファイル自体はマスクされませんが、そのファイルを読むツール出力はマスクされます
- ユーザーがチャットへ直接貼ったキーはモデルへはそのまま渡ります（画面・SSE・イベントログにはマスクが掛かります）
- 分割・Base64など変換されたキーや、未登録の秘密情報は検出できません。OAuth トークンの取得・更新は対象外です
- ユーザーが作業領域へ置いたファイルの内容はツールから読めます。認証情報を作業領域へ置かないでください

設計の詳細は [docs/architecture.md](docs/architecture.md) の「APIキー漏洩の抑制」を参照してください。

## 構成

- `server/`: BFF（Hono + TypeScript）。`src/app.ts` がルーティング / SSE / 静的配信と `AppType` export、`src/schema.ts` が zod スキーマと DTO 型（API 契約の正）、`src/sessions.ts` がセッションとラン（非同期実行）、`src/agent.ts` が pi SDK ランタイム生成とモデル候補、`src/agents.ts` がエージェント定義とスキル割り当て。APIキー保護は `src/redact.ts`（マスク本体）、`src/secret-guard.ts`（SDK接続）が担う
- `server/src/sandbox/`: ツール実行サンドボックス（BFF と別プロセス）。`src/sandbox/service.ts` が認証付きツール実行API（NDJSON ストリーム）、`src/sandbox/client.ts` が BFF 側クライアント、`src/sandbox/remote-tools.ts` が SDK 組込みツールのリモート定義、`src/sandbox/index.ts` が起動エントリ
- `client/`: チャット UI（Vite + React 19 + TypeScript + Tailwind CSS v4）。`pnpm build` で `client/dist/` にビルドされ、BFF が配信する。`src/api.ts` は hc 型安全クライアント
- `server/test/`: node:test（pi はスタブで実 API を呼ばない）
- `client/test/`: node:test（DOM を使わない純粋なクライアントロジックのみ。設定変更応答の競合など）

## ドキュメント

- [AGENTS.md](AGENTS.md) — エージェント向けの最小ガイド
- [docs/architecture.md](docs/architecture.md) — 非同期実行とセッション管理の設計
- [docs/api.md](docs/api.md) — HTTP API リファレンス（SSE イベント定義を含む）
- [docs/migration.md](docs/migration.md) — 移植元・履歴保存・CI対応の変更点

## Docker / CI・CD

モノレポのPR CIは `test` ステージで型チェック、スタブを用いたテスト（server: 非同期実行と API、client: 設定変更の応答適用）、フロントエンドビルドを実行します。専用のlinterはまだ導入していません。mainへのマージ後は既存CDが `final` ステージをビルドし、次のイメージをGHCRへpushします（自動デプロイは行いません）。`final` のビルドも `test` を経由します。

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
- APIキーは上の例のようにホスト側から環境変数（`-e ANTHROPIC_API_KEY`）で渡します。キー入りの `.env` を `/workspace` へマウントしないでください。エージェントのツールがそのファイルを読めます。APIキーやOAuth認証ファイルをイメージへ焼き込まないでください。OAuthを使う場合は専用の認証領域を実行時に渡し、更新時の書込みも考慮してください。ホストの `~/.pi` は自動共有されません。
- Bash、Git、ripgrep、fd-find、Node.jsを同梱しています。任意の開発環境が揃っているわけではありません。必要なツールは用途に合わせて追加してください。
- セッションとエージェント／スキル定義はメモリ内のみで、コンテナを再起動すると消えます。必要な定義は画面からエクスポートしてください。

### サンドボックス（ツール実行サービス）を分離して動かす

イメージはBFFとサンドボックスで共用し、`command` だけ差し替えて2コンテナで起動します。ツール実行API（`8080`）はホストへpublishせず、BFFとのみ内部ネットワークで到達します。

```bash
docker network create pi-agent-gui-net

# サンドボックス（作業領域を永続マウントする。BFF にはマウントしない）
docker run -d --name pi-agent-gui-sandbox --network pi-agent-gui-net \
  -e PI_SANDBOX_TOKEN=同じ共有トークン \
  --mount type=bind,src=/absolute/path/to/workspace,dst=/workspace \
  pi-agent-gui:local node --import tsx src/sandbox/index.ts

# BFF（作業領域はマウントしない）
docker run --rm --init --name pi-agent-gui --network pi-agent-gui-net -p 127.0.0.1:4317:4317 \
  -e ANTHROPIC_API_KEY \
  -e PI_SANDBOX_URL=http://pi-agent-gui-sandbox:8080 \
  -e PI_SANDBOX_TOKEN=同じ共有トークン \
  pi-agent-gui:local
```

- `PI_SANDBOX_TOKEN` は BFF とサンドボックスの2コンテナにだけ渡す実行API認証用の共有トークンです。LLM認証情報とは別の値を使い、他の環境変数やファイルへ展開しません
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動くため、マウント先はこのユーザーが読み書きできる所有権にしてください
- 正式なCompose構成・永続領域・資格情報の配置はデプロイ側リポジトリ（self-hosted-runner）で管理します

CDの仕組みは [モノレポのCI/CD](../../../docs/about-cicd.md) を参照してください。
