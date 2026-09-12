# 非同期実行とセッション管理の設計

ブラウザ ⇄ BFF（`server/src/app.ts`、Hono）⇄ pi SDK（`server/src/agent.ts`）⇄ サンドボックス（`server/src/sandbox/`、ツール実行）という 4 層構成。エージェントの実行ライフサイクルは HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。LLM 認証情報は BFF 層までで止まり、サンドボックス層へは渡らない。

## 基本原則

1. **実行は裏で続く**: `POST /messages` は 202 で即時返却する。クライアントが切断されても、タブを閉じても、ラン（1 回の `session.prompt()`）は最後まで続く。
2. **イベントはセッション単位のログに積む**: 全イベントは連番（`seq`）付きでメモリ上のログに追記され、後から購読したクライアントに取りこなしなくリプレイできる。
3. **停止は明示的に**: SSE 切断では止めない。`POST /stop` のみが実行を中断し、キューを破棄する。

## ランのライフサイクル

```
POST /api/sessions/:id/messages { text }
  ├─ アイドル → SessionStore.startRun() → 202 { queued: false, runId }
  └─ 実行中   → キューに積む           → 202 { queued: true, queueDepth }
                    （キューは最大 10 件。超過は 429）

startRun():
  1. run オブジェクト生成（status: "running"）
  2. run_start イベントを記録
  3. session.subscribe() で pi のイベントを変換して記録
     - message_update / text_delta → text
     - tool_execution_start/end    → tool_start / tool_end
     - agent_settled               → 終了判定
  4. session.prompt(text) を fire-and-forget で呼ぶ（await しない）
  5. agent_settled（または prompt の解決）で finish():
     - 最終テキストの取りこぼし補完（delta が来なかった場合の差分送出）
     - run.status を completed / stopped / error に確定
     - run_end イベントを記録
     - キューがあれば 200ms 後に pump() で次のメッセージを実行
```

## 状態

セッションの状態は `SessionStore.statusOf()` が導出する。

| 状態 | 意味 |
| --- | --- |
| `idle` | ランなし |
| `running` | ラン実行中 |
| `queued` | 待機メッセージあり |
| `completed` | 最後のランが完了 |
| `stopped` | 最後のランがユーザー停止 |
| `error` | 最後のランがエラー |

## イベントログと SSE

- ログは `{ seq, type, data, at }` の配列。セッションごとに直近 2000 件を保持。
- `GET /api/sessions/:id/events?after=N` が SSE 購読エンドポイント。
  - `seq > N` のエントリをリプレイしてからライブ配信に合流する。
  - 各イベントは `id: seq` 付きで送出するため、ブラウザの `EventSource` は自動再接続時に `Last-Event-ID` ヘッダを送り、サーバはこれを `after` のフォールバックとして使う。
  - クライアントのカーソルがバッファより古い（取りこぼしが埋められない）場合は、ログをリプレイせず `resync` イベント 1 件（セッション全体のペイロードを含む）を送り、クライアントは再描画する。
- 接続はハートビート（`: ping`、15 秒ごと）で維持する。購読は複数タブから可能で、切断してもランには影響しない。

## 会話履歴

- 履歴の正は pi セッション（`SessionManager.inMemory`）の `messages`。`GET /api/sessions/:id` が user / assistant のテキストに整形して返す。
- タイトルは最初のユーザーメッセージ（60 文字）から自動生成。セッション一覧 `GET /api/sessions` は状態・件数・最終使用時刻付きで返す。
- セッションの作成は最初のメッセージ送信時。未送信の新規チャットは `POST /api/sessions` を呼ばず、一覧にも出ない（エージェント切替・「新しい会話」・起動時の復元先無しはローカル状態のリセットだけで完結する）。作成前の Model / Effort 選択は次の作成時に `POST /api/sessions` の body として送られる。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。

## Model / Effort の解決と変更

アプリ既定モデルは `ModelRuntime.getAvailable()` の結果（認証済みモデルのみ）から決める。`PI_MODEL` を明示していればそれを使い、利用できない場合は別のモデルへ黙ってフォールバックせず `health.defaultModelError` として返す（`ready` は候補が 1 つ以上あれば true のまま）。`PI_MODEL` 未指定なら先頭候補を使う。

`PI_MODELS`（`provider/model` のカンマ区切り）を指定すると、available を組み立てる 1 箇所で whitelist との積を取り、そこから導出する `availableModels` / `modelOptions` / `selectedModel` / `resolveModel()` を一貫して絞り込む。個別にフィルタを足すと `PATCH /api/sessions/:id/settings` の経路から漏れるため、絞り込みはこの 1 箇所だけに置く。`PI_MODELS` 未指定は全件表示（後方互換）。whitelist と available の積が空なら（available の取得自体が例外になったときはそのエラーを優先）、`availabilityError` に `MODEL_WHITELIST_EMPTY_MESSAGE` を入れて `health.ready` を false にし、`errorCode: "model_whitelist_empty"` で原因が whitelist だと分かるようにする。認証が無い場合も whitelist が効いている以上候補は空になるため、このエラーは認証エラーより優先する。

新規チャットの初期値は項目別に「作成時のチャット指定 → エージェント定義 → アプリ既定」の順で `SessionStore.create()` が解決し、`createAgentSession()` へ渡す。`thinkingLevel` の非対応値は SDK がモデル能力で補正する（BFF では模倣しない）。

```
POST /api/sessions { model?, thinkingLevel? }
  └─ create(): request ?? agent def ?? undefined (undefined はランタイムのアプリ既定)
       └─ pi.createSession(): available と厳密照合してから SDK 作成 (不在は 400 / 候補ゼロは 503)
```

チャット単位の変更は `PATCH /api/sessions/:id/settings`。同じ SDK セッション・履歴・タイトルを保ち、実効値は pi セッション（`session.model` / `session.thinkingLevel`）を正とする。

送信（`POST /api/sessions/:id/messages`）は text だけを受け取り、モデルはそのセッションの SDK セッションが持つ実効値（`session.model`）で決まる。送信ごとのモデル指定は無いため、表示（入力欄 / ヘッダー）と実際の送信先が食い違わないよう、クライアントは選択中セッションの実効モデルだけを表示する。

1. 実行中・キューあり・SDK 非 idle・設定変更中なら 409（変更前にフラグを同期的に予約する）。
2. モデルは available と厳密照合（不在は 400）。
3. モデルだけの変更では、変更前の実効 `thinkingLevel` を退避して `setModel(model, {persist:false})` の後に再適用する（SDK のモデル切替既定に任せない）。両方指定時は要求値を再適用する。
4. `finally` でフラグを解除し、SDK 補正後の実効値で `resync` イベントを記録して返す。

エージェント定義の編集・インポートは既存チャットに遡及しない。表示用のエージェント情報（名前・説明・スキル）は作成時に `SessionRecord` へスナップショット化し、定義の変更・削除後も `payload.agent` は作成時のままになる。

## 停止

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 待機キューを破棄し `queue_cleared` イベントを記録
2. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す）
3. `finish()` が `run_end`（status: `stopped`）を記録。キューは破棄済みなので次のランは起動しない

`DELETE /api/sessions/:id` は停止 + 破棄 + 購読者への `session_deleted` 通知を行う。

## ライフサイクル / 制限

- セッションはプロセスのメモリ内のみ。1 時間未使用のアイドルセッションは SWEEP で破棄（実行中・キューありは対象外）。
- サーバ終了時は全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。

## API 契約と型安全化

- 入出力の DTO は `server/src/schema.ts`（zod）が正。リクエストボディは `@hono/zod-validator` で検証し、レスポンス型はハンドラの戻り値から推論される。
- `server/src/app.ts` はルートをチェーン形式で定義し `AppType` を export。client は `hc<AppType>(location.origin)` で型付きクライアントを構築する（`client/src/api.ts`）。SSE は型付け対象外で、`EventEntry` のみ server から型 import する。
- server / client の両 tsconfig は `moduleResolution: bundler` + noEmit。server は tsx で実行するため拡張子なし import で統一し、client は workspace package `server` のソースを型として直接参照する。
- カタログ CRUD の body はわざと pass-through（zod 厳格化しない）。エージェント名の必須チェックや `model` / `thinkingLevel` の正規化・日本語エラー文言は `agents.ts` 側が正。
- モデル能力（対応する Effort の段階）は `@earendil-works/pi-ai` の公開ヘルパー `getSupportedThinkingLevels` / `clampThinkingLevel` を使う。`@earendil-works/pi-ai` は SDK と同じ 0.85.1 系を直接依存として持ち、推移依存の内部パスや dist 深部は import しない。

## ツール実行のサンドボックス分離

作業用ツール（read / bash / edit / write / grep / find / ls）は BFF プロセス内では実行しない。pi SDK の `customTools` で同名の組み込みツールを「サンドボックス実行APIを呼ぶリモート定義」で置き換え、BFF が任意の作業コードを実行する経路を無くす。LLM 認証情報は BFF だけが保持し、サンドボックスのプロセス・環境変数・ファイルシステムには渡らない。

### 構成

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

### 認証と到達性

- すべての `/v1/*` は `Authorization: Bearer PI_SANDBOX_TOKEN` を要求し、長さを漏らさない定数時間比較で検証する。未認証は 401
- `/healthz` は無認証（Compose healthcheck 用）。ツール実行の情報は含まない
- ツール実行APIはホストへ publish しない。BFF ⇄ サンドボックスは専用の内部ネットワークのみで到達する。トークンは BFF とサンドボックスの 2 サービスにのみ渡す（LLM 認証情報とは別の値）
- `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定のとき、BFF はセッション作成を 503 で拒否する（ローカル実行へのフォールバックなし）

### パスと並行実行

- BFF のセッション cwd（`PI_APP_CWD=/workspace`）とサンドボックスの作業領域（`PI_SANDBOX_CWD=/workspace`）を同じコンテナ内パスに揃え、パス変換なしでサンドボックス側へ解決させる。作業領域の永続マウントはサンドボックスだけへ付け、BFF には付けない
- 実行は toolCallId / executionId 単位で独立し、複数セッションの並行実行でも要求と出力が混線しない。ブラウザ切断はランに影響せず（§ランのライフサイクル）、明示停止（`POST /stop` → `session.abort()`）だけが対象のツール実行を中断する

### 配布イメージと起動契約

- イメージは BFF とサンドボックスで共用し、`command` だけ差し替える（`node --import tsx src/sandbox/index.ts`）。CD（`final` ステージ）の単一イメージ前提を維持する
- イメージには bash / git / ripgrep / fd-find（`fd` へ symlink）を事前搭載する。ripgrep・fd はサンドボックス内で必要
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動く。ホスト側の永続領域実パス・所有権・Compose 構成はデプロイ側リポジトリ（self-hosted-runner）で管理する

## APIキー漏洩の抑制

プロバイダーAPIキーを環境変数で BFF へ渡す運用でも、キーが LLM・ブラウザ・ログへ流れにくくする多層防御。ツール実行自体はサンドボックスへ分離済みで、ここで述べるのは BFF 内での出力マスク（キーが作業領域のファイル等へ現れた場合の二次漏洩対策）と、SDKの公開APIだけて実装する縛り。

### 保護対象

- `createRuntimeSecretMasker()`（`server/src/secret-guard.ts`）が `ModelRuntime.getProviders()` の各プロバイダーに対し pi-ai の公開ヘルパー `findEnvKeys()` で「設定済みのキー変数」を解決し、その非空値を保護対象にする。findEnvKeys が解決しない既知プロバイダーのキー変数（Bedrock の `AWS_BEARER_TOKEN_BEDROCK`）は補完テーブルで埋める。独自プロバイダー分は `PI_SECRET_ENV_VARS` で変数名を追加する
- 自動解決された値は 8 文字未満を通常出力の過剰改変防止のため対象外にする。`PI_SECRET_ENV_VARS` で明示指定された変数は運用者の意図なので長さに関係なく保護する。重複・包含する値は長い順に置換する
- ユーザーがチャットへ直接入力したキーはモデルへはそのまま渡る（対象はツール出力由来の値）。ただしエコー（タイトル・プロンプト表示・メッセージ履歴・text delta）はマスクする
- ツール引数・出力の要約は、切り詰めの前にマスクする。先に切り詰めると要約上限の境界でキーの末尾が欠け、大部分がそのまま残るため

### レイヤー

1. **実行の分離（`server/src/sandbox/`）**
   - 作業用ツールは全てサンドボックス（別プロセス・別コンテナ）で実行する。BFF は子プロセスを起こさないため、子プロセスの環境変数を絞る旧 child-env.ts は役目を終えて廃止した
   - サンドボックスには LLM 認証情報を渡さない。bash が何を読んでも（`BASH_ENV`・`~/.bashrc` 等）、キーはそこに存在しない
2. **ツール定義のフック（`server/src/secret-guard.ts`）**
   - `createRemoteToolDefinitions` が作るリモート定義を `wrapToolDefinitionWithSecretMasker` で包み、途中出力（`onUpdate`。bash は累積スナップショットが来るので末尾保留・先頭部分一致付きでマスク）・最終結果・エラーメッセージをマスクする。エラーは完全一致のときのみ元の Error を保持する
3. **tool_result 拡張（同ファイル）**
   - インライン拡張（`DefaultResourceLoader` の `extensionFactories`）で `tool_result` を購読し、全ツールの最終結果を LLM・履歴・`tool_execution_end` イベントへ渡る前にマスクする。`noExtensions: true` でもインラインファクトリは読み込まれる。シェル以外のツール（read / grep 等）もここで一括して掛かる
4. **BFF の送出層（`server/src/sessions.ts`）**
   - SSE / イベントログへ出すテキスト（text delta、メッセージ、ツール引数・出力、エラー、プロンプトのエコー、タイトル）を防御的にマスクする
   - ツール引数・出力の要約は、切り詰めの前にマスクする。先に切り詰めると要約上限の境界でキーの末尾が欠け、大部分がそのまま残るため
   - アシスタントの差分は `createStreamingSecretMasker` で配信前に「秘密値の前方一致になり得る末尾」を保留し、チャンク境界をまたぐキーが複数回の配信から復元できないようにする。保留分は `message_end`（アシスタント確定時）と `finish()`（完了・エラー・中断のいすれでも）でフラッシュする

### 切り詰め境界への対応

SDK はツール出力をいくつかの方法で切り詰める。キーが切り詰め境界に跨ると、結果のテキストには完全一致が現れなくなり完全一致の置換だけでは検出できない。このため `maskSafe`（最終結果）と `maskAccumulated`（累積スナップショット）は次の部分一致も置換する。

- **先頭の欠落**: bash ツールの末尾 50KiB / 2000 行切り詰めで、結果のテキストがキーの途中から始まるケース。先頭の部分一致（4 文字以上）を `[REDACTED]` へ置換する
- **行境界の欠落**: grep が一致行を 500 文字へ切り詰めて `... [truncated]` マーカーを付与するケース。マーカー直前のテキストがキーの前方一致で終わる場合、その断片（4 文字以上）を `[REDACTED]` へ置換する

4 文字未満は再構成リスクが小さく、通常出力への誤置換を避けるため対象外とする。

### 検証

実APIは呼ばず、ダミーキーとスタブで検証する。

- `server/test/sandbox-service.test.ts` — 実行APIの認証（未認証 401・未知ツール 404）、実SDKのbash/read/write/grepによる実行とNDJSON、rootCwd 基準のパス解決、cancel による中断と速やかなストリーム閉鎖、セッションメタ変数・トークンが子プロセス出力へ出ないこと、close での全実行中断
- `server/test/sandbox-client.test.ts` — NDJSON 解釈（start/update/result/error）、abort 時の cancel エンドポイント発火と `Operation aborted`、HTTP エラーの文言変換
- `server/test/secret-guard.test.ts` — リモート定義を包むマスカーの出力マスク、途中出力とエラーのマスク、SDKの切り詰めで先頭が欠けたケース、実SDKのgrepで行切り詰め境界に跨った断片のマスク、`tool_result` 拡張
- `server/test/redact.test.ts` — マスク本体（重複値、チャンク境界、中断時のフラッシュ）
- `server/test/sessions-secrets.test.ts` — SSE イベント・payload・エラー経路のマスクと、秘密を含まない出力が改変されないこと

### 残存リスク

- 非rootコンテナ・別プロセスは完全な隔離ではない。同一ユーザーのサンドボックス内では会話間のセキュリティ分離はなく、ファイル・ポート・Git の共有情報は競合し得る
- サンドボックスから外向きの通信は制限していない。ツールで実行したコードはネットワークへ到達できる。ネットワーク制限・リソース上限の具体値はデプロイ側の運用に委ねる
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされないが、それを読むツール出力はマスクされる
- 分割・エンコードされたキーや未登録の秘密情報は検出できない。OAuth トークンは対象外
- ユーザーが作業領域へ置いたファイルの内容はツールから読める。認証情報を作業領域へ置かない運用とする

## フロントエンド

チャット UI は `client/` ワークスペースに切り出し、React 19 + Vite + TypeScript + Tailwind CSS v4 で実装している。ソースは `client/src` 配下に置き、エントリは `main.tsx`（`index.html` から読み込む）。SSE イベントは reducer で状態に変換し、旧実装（命令的な DOM 操作）の挙動を忠実に再現する。

### テーマシステム

- テーマは `html` 要素の `data-theme` 属性で決定し、各プリセットが CSS 変数（`--c-*`）を定義する。Tailwind v4 の `@theme inline` で CSS 変数をセマンティックトークンにマップし、コンポーネントはトークンクラス（背景色・文字色など）だけで書く。プリセットの再配色は CSS 変数定義だけで完結するが、テーマの**追加**は CSS 変数（`html[data-theme]` プリセットと `.theme-swatch`）に加えて `client/src/theme/themes.ts` の `THEMES` と `client/public/theme-init.js` の id 配列も更新する（両者の同期は `client/test/themeSync.test.ts` が固定する）。
- アクセントは面用途（`--c-accent` / `--c-accent-bright`。送信ボタン・自分の発言バブル・テーマの色見本）と線・リング用途（`--c-focus`。入力欄の focus 枠・`focus-visible` リング・アクティブタブの下線・checkbox）でトークンを分ける。面用途は明るいまま、`--c-focus` は各プリセットで隣接面に対して 3:1 以上（WCAG 1.4.11）を満たす値にする。
- プリセットは 6 種類（ミッドナイト / デイライト / モカ / フォレスト / サクラ / スカイ）に加え、`prefers-color-scheme` に追従する「システム」を選択できる。
- 状態は `ThemeProvider`（`useTheme` フックで参照・変更）が持ち、選択は `localStorage` に保存される。削除済みのテーマ id など無効な値が残っていても system 追従として解決し、保存値は書き換えない（新しく知るテーマを選び直したときに初めて上書きされる）。
- `client/public/theme-init.js` は React 初回描画より前に `data-theme` を適用する外部 classic script。ここを React 側でやると初期化完了までテーマなしで点滅するため、意図的に React の外に置いている。ロジック（localStorage のキー、system 追従の解決）は `ThemeProvider` と同じ選択結果になるよう同期を取る（system の解決先 id は `client/test/themeSync.test.ts` が突き合わせる）。
- BFF の CSP は `style-src 'self'`（インラインスタイル不可）のため、テーマはすべて外部 CSS + 属性切替で実装する。`<style>` の注入やインライン `style` 属性には頼らない。

### チャット状態とレンダリング

- SSE イベント（`text` / `tool_start` / `tool_end` / `run_end` など）を React の reducer で受け、イベントログから UI 状態（メッセージ列、ツールカード、実行状態）を導出して仮想 DOM へ反映する。旧 `app.js` のようにイベントハンドラで DOM を直接書き換えるのではなく、「イベントの適用」を純粋な状態遷移として書くことで、再接続時のリプレイ / `resync` も同じ reducer で処理できる。
- 接続管理（`EventSource` の再接続、`Last-Event-ID`、`resync` の検知）はカスタムフックに集約し、コンポーネントは描画に集中する。
- セッションの作成は送信経路（`sendMessage` → `ensureSession`）に置く。未作成チャットで送信したときだけ `POST /api/sessions` を呼び、その応答で sessionId / 履歴 / 実効 Model を差し替えてから SSE を張り直して送信する。作成待ちの間に別のチャットへ切り替えられたら選択は奪わず、送信先は `ensureSession` の戻り値を使う（入力も作成済みセッションも捨てず、空のセッション行を残さない）。作成に失敗したときは未作成チャットのままエラーを表示する。
- 入力欄の Model / Effort ピッカーは `Composer` に置く。セッションがあれば `resync` で受け取った実効値、未作成のチャットでは「作成前の選択 → 選択中エージェントの定義 → health のアプリ既定」を同じ優先順位で表示する。選択は未作成ならローカルに保持して `POST /api/sessions` に乗せ、作成済みなら `PATCH /api/sessions/:id/settings` を呼んでサーバーの実効値へ同期する。生成中・キュー待ち・設定変更通信中はピッカーを無効化し、設定変更通信中は送信も待たせる。
- ヘッダーのモデル表示は `client/src/hooks/modelDisplay.ts` が導出する。選択中セッションでは会話の実効モデル（`resync` の `payload.model`）だけを使い、サーバー既定（`health.model`）へフォールバックしない。未作成のチャットに限りアプリ既定を「既定」と明示して出す。状態として持たず毎レンダー導出するため、リロード・会話切替・`/api/health` 再取得の応答順に左右されない（`applyHealth` は接続状態だけを更新する）。
- 設定変更の応答適用は `client/src/hooks/settingsChange.ts` に切り出す。応答や回復 GET を待っている間にサイドバーで別のチャットへ切り替えられるため、各 await の後に「要求したセッションがまだ選択中か」を確認し、切替済みの古い応答では履歴 / Model / Effort / `lastSeq` / 活動表示を更新しない。

### 開発フローと配信

- 開発時は `pnpm dev`（BFF :4317）と `pnpm dev:web`（Vite :5173、HMR 付き）を併用する。Vite は `/api` を 4317 へプロキシするため、フロントエンドは同一オリジンの API としてそのまま動く。
- 本番は `pnpm build` の産物 `client/dist/` を BFF が配信する。静的配信はリクエストパスを `client/dist` 内のファイルに解決し（ディレクトリ外は 404）、`index.html` は `no-cache`、Vite のハッシュ付き `assets/` 配下は `immutable` でキャッシュする。未ビルドのときは 503 で案内を出す。CSP は変わらず `default-src 'self'` のため、ビルド産物も同一オリジンのアセットだけで動く。
## クライアントの Effect 契約

- 起動時の復元とセッション一覧のポーリングは別の Effect とする。起動処理は表示期間に一度開始し、エージェント選択の変更では再実行しない。起動処理はセッションを作らない（復元先が無ければ未作成チャットのまま表示し、最初の送信で作成する）。
- cleanup 後は、起動処理から呼ぶカタログ取得・一覧取得・セッション復元・health 取得の応答を適用しない。一覧取得は後から開始した要求を優先する。送信経路（`sendMessage` → `ensureSession`）のセッション作成 POST 自体を取り消す保証はない。
- SSE はセッション ID・再接続カウンタに同期し、通知処理は `useEffectEvent` で最新の callback を参照する。OS テーマは `useSyncExternalStore` で購読する。
- 管理フォームは選択対象とカタログの変更を render 中に検出して自身の state を初期化する。カタログ再読込でも未保存入力をリセットする既存の挙動を維持し、dialog 自体は再マウントしない。
- DOM のテーマ反映・入力欄の高さ・チャットのスクロール・dialog のフォーカス同期には Effect を残す。コピー完了待ちの要求は cleanup で無効化する。
