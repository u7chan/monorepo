# u7agent

pi SDK を BFF に埋め込んだ小さなブラウザ GUI です（`projects/u7agent`）。client は Vite + React 19 + TypeScript + Tailwind CSS v4、BFF は Hono + TypeScript です。client は `hono/client` で型安全に API を呼びます。セッションは BFF 専用の会話ストア（`PI_SESSION_STORE`）へ保存するため、再起動後も一覧・履歴・続きの送信を復元できます。エージェント定義とプロジェクトはアプリデータの SQLite（`<PI_SESSION_STORE>/u7agent.db`）へ保存し、再起動後も残ります。スキルはワークスペースの `.agents/skills`（共通・プロジェクト）とアプリ同梱の組み込みをファイルとして扱います。

メッセージの送信は即時に返り、エージェントはバックグラウンドで動き続けます（ブラウザを閉じても継続します）。作業用ツール（read / bash / edit / write / grep / find / ls）は、BFF から分離したサンドボックスプロセスで実行します。

![ユーザーがブラウザから操作し、エージェント本体（BFF）がサンドボックスへツール実行を要求する構成図。Web 検索・画像生成・音声生成は BFF 内の組み込みツールとして動き、サンドボックスは作業用ツールとヘッドレスブラウザを実行する。アプリ側とサンドボックスは破線のプロセス境界で分かれ、渡るのは共有トークンだけで、ワークスペースはサンドボックスにだけマウントされる](docs/assets/architecture.webp)

エージェント本体（BFF + pi SDK）が会話と判断を持ち、実際の作業はサンドボックスが行います。LLM の API キーは本体の内側で止まり、サンドボックスへは共有トークンだけを渡します。ポートやマウント先の具体値はデプロイ環境ごとに決まるため、図には含めていません。

設計の全体像は [docs/architecture.md](docs/architecture.md)、変更テーマ別の入口は [docs/README.md](docs/README.md) にあります。

## ローカルで起動する（Docker なし）

Node.js 24 と pnpm 10.34.5 を使います。初回だけ `pnpm install`。

```bash
pnpm dev   # サンドボックス + BFF + Vite をまとめて起動 → http://localhost:3000
```

- サンドボックスは常に別プロセスです。`pnpm dev` が共有トークンを生成してサンドボックスと BFF の両方へ渡します（ローカルで Docker は不要）
- 作業領域は既定でこのディレクトリです。変えるときは `PI_APP_CWD=/path/to/project pnpm dev`（プロジェクト登録と未所属チャットの起点になります）
- **Linux と Landlock ABI 3 以上（カーネル 6.2 以上）が必要です**。`bash` は書き込みを作業ディレクトリ・共通スキル・`/tmp`・ホーム配下のキャッシュへ限るため、満たさない環境（macOS、古いカーネル）では `bash` を実行できません。`pnpm dev` はラッパーを `$HOME/.local/libexec/u7agent` へ配置します（許可 root の外に置き、エージェントに書き換えられないようにするため）
- APIキーは起動後に **設定 → モデル** から登録できます（アプリのデータベースに保存され、再起動後も使われます）。`~/.pi/agent/auth.json` があれば不要です
- 停止は Ctrl-C（3 プロセスまとめて止まります）

## 機能

- **プロジェクトとセッションの作業ディレクトリ** — 登録したプロジェクトのセッションはそのディレクトリを cwd にし、未所属チャットは既定スペースでは `<workspace root>/.u7agent/sessions/<id>` のスクラッチで動きます（[docs/projects.md](docs/projects.md)）
- **会話の引き継ぎ** — 会話の行の ⋯ から、同じ会話のままエージェントや会話スペースを代えて続けられます（履歴は破棄、タイトル・ピン・通知は維持）。要点を作業フォルダ直下の `HANDOFF.md` に書き出せるほか、引き継ぎ直後の入力欄にチップが出て必要なときだけ参照させられます（[docs/run-lifecycle.md](docs/run-lifecycle.md#引き継ぎと復旧) / [docs/api-sessions.md](docs/api-sessions.md#post-apisessionsidmove)）
- **ファイルの持ち出し（ダウンロード）** — 設定 → ファイル と右パネルのツリーの行から保存できます。ファイルは元の名前のまま生バイトで、フォルダは ZIP です。除外規則と上限は [docs/file-preview.md](docs/file-preview.md#ダウンロード)
- **スキル** — ファイルスキル（`.agents/skills`）と組み込みスキルの 2 種類があり、入力欄から `/skill:<name>` で展開します（[docs/persistence.md](docs/persistence.md#スキルの扱い) / [docs/api-catalog.md](docs/api-catalog.md#ファイルスキルagentsskills)）
- **サービス（serve）** — エージェントが起動した Web サーバーを別タブで開き、トップバーから起動・停止・入れ替えができます（[docs/sandbox.md](docs/sandbox.md#serveサービスの公開と起動停止)）
- **組み込みツール（Web 検索 / 画像生成 / 音声生成）** — 設定 → Web 検索（`/settings/web-search`）と設定 → コンテンツ生成（`/settings/content`）で有効にすると、モデルから `web_search` / `generate_image` / `generate_speech` を呼べます。生成した画像と音声は作業フォルダへ保存し、チャットでプレビュー・再生できます（[docs/web-search.md](docs/web-search.md) / [docs/image-generation.md](docs/image-generation.md) / [docs/speech-generation.md](docs/speech-generation.md)）
- **ヘッドレスブラウザ** — 固定版の Chromium をサンドボックスへ同梱し、エージェントが `bash` から `u7agent-browser` で起動中のアプリを開いて確認・撮影・失敗の収集ができます（[docs/browser.md](docs/browser.md)。使い方は組み込みスキル `browser`）
- **通知（Discord）** — 会話ごとのトグルが On のとき、応答の先頭 200 文字を 1 通送ります。応答が返らない質問待ちでも、設定 → 通知の「質問の通知」を On にしていれば、質問が発生したことと会話のリンクが届きます。会話の通知が Off の場合は本文なし、On の場合はタイトルと第 1 問も載ります（[docs/notifications.md](docs/notifications.md)）

## 環境変数

設定できる変数の一覧と説明は [.env.example](.env.example) が正です（`cp .env.example .env` で読み込まれ、`.env` を読むのは BFF だけ）。サンドボックス側は [docs/sandbox-api.md](docs/sandbox-api.md)、BFF の待受とオリジンの契約は [docs/api.md](docs/api.md) を参照してください。

- 利用可能なモデル、アプリ既定モデル、プロバイダーAPIキーは起動後に **設定 → モデル** から設定するのが既定です（アプリのデータベースへ保存し、再起動せずにモデル候補へ反映します）。選択の入口は GUI に一本化したため、`PI_MODEL` / `PI_MODELS` / `PI_PROVIDER` は読みません（移行は [docs/model-settings.md](docs/model-settings.md)）
- 作業フォルダごとの環境変数（**作業環境 → 環境変数**）は GUI から登録します。変数は平文で保存し、エージェントの `bash` とサービスの両方から見えます。シークレットは保存時に暗号化し、サービスの起動時だけ注入します（エージェントの `bash` の env には入りません。master key は `U7AGENT_SECRET_MASTER_KEY` / `U7AGENT_SECRET_MASTER_KEY_FILE` でアプリ DB とは別経路。値の規則と残存リスクは [docs/secrets.md](docs/secrets.md#作業フォルダの環境変数)）
- ポートを変えると、プレビューの `localStorage` の保存領域も別になります。`pnpm dev` をもう 1 つ並行して起動するときはプレビュー以外のポートも分けてください（[docs/frontend.md](docs/frontend.md#開発フローと配信)）

## セキュリティ

- **ログイン認証はありません。インターネットや LAN へ公開しないでください**（BFF の待受は既定で `127.0.0.1`）。プレビュー オリジン（既定 4318）とサービス オリジン（既定 4319）も無認証で、公開するのは信頼できる閉域 LAN に限ります
- `pnpm dev` の Vite だけは実機確認のため LAN へも待受けます（`0.0.0.0:3000`）。同じ LAN の端末からは、認証なしの GUI と `/api` が開けます（サンドボックスでの `bash` 実行に到達します）。開発用途に限ってください。プレビュー オリジンとサービス オリジンは Vite を通さずブラウザが直接開くため、LAN / 別端末から使うときは `HOST=0.0.0.0` に加えてそれらのポートの到達（WSL2 なら portproxy の追加）が要ります（届かないとプレビューは真っ白になります。[docs/frontend.md](docs/frontend.md#開発フローと配信)）
- ツールはサンドボックスの作業領域でコマンド実行やファイル変更ができます。`write` / `edit` はセッションの作業ディレクトリと `<workspace root>/.agents/skills` に限られ、`bash` とその子プロセスも、Landlock により、作業ディレクトリ・共通スキル・`/tmp`・ホーム配下のキャッシュ・デバイスファイル以外でのファイルの作成・書き込み・削除・rename・truncate が `EACCES` になります（カーネル 6.2 以上が必要。満たさない環境では `bash` を実行できません）。Landlock は `chmod` / `chown` / `utime` などの属性変更や読み取りまでは制限できないため、信頼できる環境だけで使ってください（[docs/sandbox.md](docs/sandbox.md#残存リスク)）
- LLM の APIキーは BFF が持ち、サンドボックスへは共有トークンしか渡しません。設定 → モデルで登録したキーはアプリデータの SQLite（`PI_SESSION_STORE/u7agent.db`）へ**平文**で保存されるため、DB・WAL・バックアップのアクセス権を管理してください（[docs/model-settings.md](docs/model-settings.md#残存リスク)）。ツール出力に現れた既知のキーは、LLM・SSE・ログへ渡す前に `[REDACTED]` へ置換します
- `pnpm dev` のサンドボックスはホスト上の別プロセスで、BFF と同一ユーザー・同一環境です（親シェルから export した APIキーや、同一ユーザーが読める `~/.pi/agent/auth.json` も見えます）。コンテナ分離の設計と残存リスクは [docs/sandbox.md](docs/sandbox.md) を参照してください
- 作業環境 → 環境変数 のシークレットだけが保存時に暗号化されます（AEAD）。プロバイダー / 画像 / Web 検索の APIキー、provider メモ、種別 = 変数の値は `u7agent.db` へ平文で残るため、「DB 全体が暗号化された」わけではありません。シークレットはエージェントの `bash` の env に入りませんが、同一サンドボックス・同一 Unix user でサービスが動くため `/proc/<pid>/environ` などを読める可能性は残ります（[docs/secrets.md](docs/secrets.md#保証範囲と残存リスク)）

## ドキュメント

- [AGENTS.md](AGENTS.md) — エージェント向けのルール（Tech Stack・検証・テスト方針・コメント）
- [docs/README.md](docs/README.md) — 変更テーマ別の索引（ここから必要なドキュメントだけを辿る）

main にマージされると、CD が配布イメージを GHCR（`ghcr.io/u7chan/monorepo/u7agent:latest`）へ push します。CD の仕組みは [モノレポのCI/CD](../../docs/about-cicd.md) を参照してください。
