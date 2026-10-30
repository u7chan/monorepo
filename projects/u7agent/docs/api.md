# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

例の JSON のモデルは `<provider>` / `<id>` のプレースホルダで示す。実値は環境の利用可能モデル（設定 → モデル（`/settings/models`）の「利用可能なモデル」と available の積）で決まる。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

このファイルは規約と索引、共通のエンドポイントを持つ。領域ごとの契約は [api-files.md](api-files.md) / [api-settings.md](api-settings.md) / [api-sharing.md](api-sharing.md) / [api-sessions.md](api-sessions.md) / [api-catalog.md](api-catalog.md) / [sandbox-api.md](sandbox-api.md) に分かれる。

## 索引

| 領域 | エンドポイント | ドキュメント |
| --- | --- | --- |
| ヘルス | `GET /api/health` | このファイル |
| スペース | `GET/POST /api/spaces`、`PATCH /api/spaces/order`、`DELETE /api/spaces/:id` | このファイル |
| ランタイムのモデルカタログ | `GET /api/runtime/models` | このファイル |
| 実行環境（サンドボックスの診断） | `GET /api/runtime/environment` | このファイル |
| ファイル一覧 | `GET /api/files` | [api-files.md](api-files.md) |
| ファイルの存在確認 | `GET /api/files/stat` | [api-files.md](api-files.md) |
| git ブランチ（作業フォルダ） | `GET /api/files/git` | [api-files.md](api-files.md) |
| ファイル削除 | `DELETE /api/files` | [api-files.md](api-files.md) |
| ファイルのリネーム | `POST /api/files/rename` | [api-files.md](api-files.md) |
| ファイルのアップロード（設定 → ファイル / 作業環境 のドラッグ＆ドロップ） | `POST /api/files/upload` | [api-files.md](api-files.md)、[file-upload.md](file-upload.md) |
| テキストプレビュー | `GET /api/files/preview` | [api-files.md](api-files.md) |
| HTML プレビュー（iframe 用。アプリ オリジン + プレビュー オリジンの 2 リスナー） | `GET /api/files/html/<root 相対>` | [api-files.md](api-files.md) |
| 画像配信（raw） | `GET /api/files/raw` | [api-files.md](api-files.md) |
| ダウンロード（ファイル / ZIP） | `GET /api/files/download`、`GET /api/files/download/check` | [api-files.md](api-files.md) |
| プロジェクト | `GET/POST /api/projects`、`DELETE /api/projects/:id` | このファイル |
| セッション | `/api/sessions`、`/api/sessions/:id`、`/skills`、`/history`、`/files`、`/messages`、`/unsent/:sendId`、`/queue/:sendId`、`/questions/:toolCallId/answer`、`/events`、`/settings`、`/title`、`/title/summarize`、`/pin`、`/fork`、`/move`、`/stop`、`/abort`、`/compact`、`/diagnostics`、`/raw` | [api-sessions.md](api-sessions.md)、[api-session-state.md](api-session-state.md)、[api-session-turns.md](api-session-turns.md)、[api-session-runtime.md](api-session-runtime.md) |
| 通知（Discord） | `GET/PUT /api/notifications`、`POST /api/notifications/test`、`PATCH /api/sessions/:id/notify` | [notifications.md](notifications.md) |
| アーカイブの除外名 | `GET/PUT/DELETE /api/settings/archive` | [api-files.md](api-files.md) |
| 共有の除外名（設定 → 共有 `/settings/sharing` の「公開の除外」） | `GET/PUT/DELETE /api/settings/shared-content-exclusions` | [api-sharing.md](api-sharing.md)、[static-sharing.md](static-sharing.md#公開の除外) |
| プロバイダーAPIキーとメモ（設定 → モデル `/settings/models`） | `GET /api/settings/models`、`PUT/DELETE /api/settings/models/:provider/key`、`PUT /api/settings/models/:provider/memo`、`POST /api/settings/models/:provider/resync`、`POST/DELETE /api/settings/models/:provider/login`、`POST /api/settings/models/:provider/login/code`、`POST /api/settings/models/:provider/logout`、`POST /api/settings/models/catalog/refresh` | [api-settings.md](api-settings.md)、[model-settings.md](model-settings.md) |
| コンテンツ生成（設定 → コンテンツ生成 `/settings/content`） | `GET/PUT /api/settings/content`、`PUT /api/settings/content/image`、`PUT /api/settings/content/speech`、`POST /api/settings/content/speech/preview`、`PUT/DELETE /api/settings/content/key`、`POST /api/settings/content/image/catalog/refresh`、`POST /api/settings/content/speech/catalog/refresh` | [api-settings.md](api-settings.md)、[image-generation.md](image-generation.md)、[speech-generation.md](speech-generation.md) |
| Web 検索の設定（設定 → Web 検索 `/settings/web-search`） | `GET/PUT /api/settings/web-search`、`PUT /api/settings/web-search/provider`、`PUT/DELETE /api/settings/web-search/providers/:provider/key`、`POST /api/settings/web-search/test` | [api-settings.md](api-settings.md)、[web-search.md](web-search.md) |
| 会話タイトルの設定（設定 → 会話タイトル `/settings/session-title`） | `GET/PUT /api/settings/session-title`、`POST /api/settings/session-title/test` | [api-settings.md](api-settings.md)、[session-title.md](session-title.md) |
| サービス（serve）の状態と起動・停止 | `GET /api/serve/status`、`POST /api/serve/start`、`POST /api/serve/stop` | [api-sharing.md](api-sharing.md)、[sandbox.md](sandbox.md#serveサービスの公開と起動停止) |
| 共有コンテンツ（公開・更新・停止・再公開・削除）と Cloudflare の接続 | `/api/shared-contents`、`/api/settings/cloudflare`、`/api/settings/shared-content-exclusions` | [api-sharing.md](api-sharing.md)、[static-sharing.md](static-sharing.md) |
| 作業フォルダの環境変数（作業環境 → 環境変数） | `GET/POST /api/secrets`、`GET/PUT/DELETE /api/secrets/:secretId` | [api-settings.md](api-settings.md)、[secrets.md](secrets.md#作業フォルダの環境変数) |
| エージェント / スキル | `/api/agents`、`/api/skills/files`（`/detail`・`/delete-preview`・`/export`・`/export/check`・`/import` を含む）、`/api/skills/session` | [api-catalog.md](api-catalog.md)、[api-session-turns.md](api-session-turns.md#get-apiskillssession) |
| 定型プロンプト（設定 → 定型プロンプト `/settings/prompts`） | `GET/POST /api/prompts`、`GET/PATCH/PUT/DELETE /api/prompts/:id` | [api-catalog.md](api-catalog.md#定型プロンプトのマスタと参照) |
| サンドボックス（内部） | `/v1/*`（BFF からは見えない） | [sandbox-api.md](sandbox-api.md) |

## スペース

- `GET /api/spaces` → `{ spaces: [{ id, name, createdAt }] }`。固定の既定スペース `{ id: "default", name: "既定", createdAt: 0 }` と保存済み追加スペースを返す。
- `POST /api/spaces` の本文 `{ name }` → 201 `{ space: { id, name, createdAt } }`。name は trim 後 1〜80 文字。内部 ID はサーバーが生成し、指定・改名・リセット API は無い。DB 障害は一覧・作成とも 503。追加したスペースは一覧の末尾に付く。
- `PATCH /api/spaces/order` の本文 `{ ids }` → 200 `{ spaces: [{ id, name, createdAt }] }`。応答は正規化後の並びで、これが以後の `GET` と一致する（`sortOrder` は app-db の内部に閉じ、応答に出ない）。採用するのは既存の追加スペースの id だけ: **既定スペース（`default`）・未知の id・重複は捨て、渡されなかった行は元の相対順で末尾に回す**（`[]` と全件未知は現行順のまま）。**既定スペースは常に先頭**で、並べ替えの対象にも入れない（テーブルに行を持たないため）。保存は全件を 1 トランザクションで書き直し、途中で失敗したら 1 つも書かない。400 = 本文が不正（`ids` の欠落・配列でない・文字列以外を含む・件数上限超過・JSON でない）、503 = DB 障害（[api-catalog.md](api-catalog.md#エージェントの表示順) と同じ方針）。
- `DELETE /api/spaces/:id` → 200 `{ ok: true }`。400 = 既定スペース（`default`）と不正な id、404 = 未知の追加スペース、409 = そのスペースの会話（または起動元不明）のサービスが公開中、503 = DB・会話ストア・サンドボックス未設定。稼働判定は状態のキャッシュを読まずに取り直し、probe の失敗は 502 / 503 のまま返す。サンドボックスの 4xx / 502 は文言ごと透過する（[削除](api-files.md#削除)と同じ）。
- 削除の対象は `spaces` 行だけでなく、会話（live / 未ロード）・履歴・作業フォルダ・添付・`secrets` / `serve_commands` の cwd キー行（[persistence.md](persistence.md#スペース)）。会話はセッション削除と同じ経路で消し（実行中は abort する）、作業フォルダの根はサンドボックスの `DELETE /v1/dirs?recursive=true`（[sandbox-api.md](sandbox-api.md#delete-v1dirs)）へ委譲する（対象が無い 404 は成功）。`spaces` 行の削除が commit point で、途中で失敗しても行が残るのでそのまま再試行できる。コミット後に残った会話 / 作業フォルダを回収できないときは 500 で報告し、そのとき行は既に無いので再試行は 404 になる。
- 削除の最中（claim 中）は、そのスペースを対象にする scoped API が**読み取りも含めて** 404 になる。同じスペースの二重削除は 409、既定スペースと不正な id は DB を読む前に 400 になる。
- 会話作成は本文の `spaceId`、それ以外の会話 API・EventSource・プロジェクト API・作成前スキルプレビュー・作業環境の環境変数 / サービス API は query の `spaceId` を使う。欠落だけ `default` として扱う。不正 ID は 400、未知の追加スペースは 404。会話作成では query ではなく本文が正。引き継ぎ（`POST /api/sessions/:id/move`）は query が要求元で、本文の `spaceId` が移動先になる。
- 引き継ぎはプロジェクト所属でも同スペースへの交代だけでき、未所属は別スペースへも移れる。履歴は破棄し、メモ（`memo: true`）では作業フォルダの `HANDOFF.md` へ要点を書き、別スペースなら作業フォルダ / 添付 / `secrets` / `serve_commands` を移動先へ移す（[api-session-state.md](api-session-state.md#post-apisessionsidmove)）。
- 会話 ID と要求スペースの不一致は 404。descriptor / live record の所属で SDK 復元・作業生成・変更の前に拒否し、取得・履歴・設定・タイトル・通知・削除・停止・圧縮・送信・未送信・回答・添付・スキル・SSE に同じ規則を適用する。環境変数・サービスの `sessionId` にも適用する。
- 追加スペースでは `GET /api/projects` は `{ projects: [] }`、プロジェクト変更と `projectId` の利用は 400。通常のプロジェクト契約は変更しない。
- 共通カタログ・共通設定・汎用ファイル API、ランタイムのサービス診断 / 全体停止は分割しない。共有サービスの所有者は全会話から解決し、全体管理の応答は起動元の所属スペースも返す（会話のリンクの `?space=`）。`spaceId` は認証・権限ではなく、指定を変えれば別スペースを選べる。
- 既定スペースの既知会話の削除・live 停止は DB 障害でも通し、壊れた JSONL の未ロード会話も SDK 復元なしで削除する。それ以外の既存 DB / 会話ストア障害の 503 契約は維持する。

## ブラウザからの書き込み（Origin / CSRF 対策）

`/api/*` の POST / PUT / PATCH / DELETE は、アップロードを含めて本文の読み取り・副作用より先に検査する。`Origin` があれば、要求 URL のオリジン（scheme + host + port）と完全一致しなければ 403 `Cross-origin mutations are forbidden`。`null` や不正な値も拒否する。`Sec-Fetch-Site` があれば `same-origin` 以外は拒否する（同じホストの別ポートも `same-site` なので許可しない）。CORS で応答を読めなくするだけでは `text/plain` の POST の副作用を止められないため、Content-Type に依存せず検査する。

両ヘッダの無い curl 等の直接クライアントは従来どおり許可する。これはブラウザの CSRF 対策であり認証でもネットワーク隔離でもない。Vite の dev proxy は外部 Host を保持し、ブラウザの Origin と一致するため許可される。転送ヘッダ（`X-Forwarded-*`）は検証に使わない。リバースプロキシを追加する場合は外部 Host を保持すること。GET と HTML プレビューの契約は変えない。

## 型の共有

- `server/src/app.ts` はルートをチェーン形式で定義し `AppType` を export。client は `hc<AppType>(location.origin)` で型付きクライアントを構築する（`client/src/api.ts`）。SSE は型付け対象外で、`EventEntry` のみ server から型 import する。
- ルートチェーン以外の実装は `server/src/routes/`（ハンドラ）、`server/src/http.ts`（body ガード / エラー変換）、`server/src/static.ts`（静的配信 / CSP）、`server/src/bootstrap.ts`（pi ランタイムと store の組み立て）に分かれている。ルートの追加・変更は `app.ts` のチェーンと該当する route モジュールを読めば済む。
- server / client の両 tsconfig は `moduleResolution: bundler` + noEmit。server は tsx で実行するため拡張子なし import で統一し、client は workspace package `server` のソースを型として直接参照する。

## ヘルスチェック

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | pi ランタイムの状態（`ready` / `model` / `modelOptions` / `defaultThinkingLevel` / `cwd` / `versions` / `filePreviewPort`）と永続化の状態。認証が無い場合は `errorCode: "authentication_required"`、保存された許可リストと利用可能モデルが交差しない場合は `errorCode: "model_whitelist_empty"` |

`ready` は「ランタイムが使え、利用可能モデルが 1 つ以上ある」の意で、アプリ既定モデル（`model`）が使えるかとは独立している。`model` はあくまでアプリ既定（新規セッションで明示も定義も無いときに使う値）で、チャットごとの実効モデルではない。チャットの実効モデルはセッションの payload / 一覧の `model` を参照する。利用可能な候補があるのに保存された既定モデルが無いときは `model` を返さず `defaultModelUnset: true` にする（候補の先頭で代用しない。この状態でモデル無指定のセッション作成は 503。候補 0 件は `defaultModelUnset` ではなく可用性エラーの側で表す）。設定 → モデル で保存した既定モデルが利用不能でも候補が他にあれば `ready: true` と `defaultModelError` を返し、別モデルへは自動で切り替えない。`sandboxConfigured` は `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が揃っているか（未設定ならセッション作成が 503 になる）を示す。`PI_MODEL` / `PI_MODELS` / `PI_PROVIDER` は読まない（設定されていても無視する）。

```json
{
  "ok": true,
  "ready": true,
  "sandboxConfigured": true,
  "model": "<provider>/<id>",
  "availableModels": ["<provider>/<id>"],
  "modelOptions": [
    {
      "provider": "<provider>",
      "id": "<id>",
      "name": "…",
      "supportsThinking": true,
      "thinkingLevels": ["off", "low", "high", "max"]
    }
  ],
  "defaultThinkingLevel": "medium",
  "defaultModelError": "保存された既定モデルは利用できません: openai/ghost",
  "defaultModelUnset": false,
  "filePreviewPort": 4318,
  "previewPort": 4319,
  "versions": { "piCodingAgent": "<version>", "piAi": "<version>" },
  "sessionStore": { "path": "/var/lib/u7agent/sessions", "ok": true, "dirty": 0 },
  "appDb": { "path": "/var/lib/u7agent/sessions/u7agent.db", "ok": true },
  "archive": { "excludeNames": ["node_modules", ".venv", "…"] }
}
```

`archive.excludeNames` はダウンロード ZIP から落とす名前の**実効値**（[ダウンロード](api-files.md#ダウンロード)）。設定ストア（[アーカイブの除外名](api-files.md#アーカイブの除外名)）が唯一の決定点で、未設定なら既定の一覧、上書きされていればその一覧になる。UI は行にダウンロードを出すかの判定だけに使い、実際の拒否は `GET /api/files/download/check` が行う（このフィールドの形と意味は変えない）。

`filePreviewPort` は**ブラウザから見た**プレビュー オリジンのポート（env `PI_FILE_PREVIEW_PORT`、既定 4318）で、クライアントは別オリジンの iframe の URL をこれで組み立てる。BFF の待受は別 env `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で、公開する配備は `<公開ポート>:<待受ポート>` の対応で公開し、公開ポートを `PI_FILE_PREVIEW_PORT` へ渡す（値の解決と検証は起動時に 1 回で、1〜65535 の整数以外は起動が止まる。2 つの env は独立で、同じ値へ揃えるのは `pnpm dev` だけ）。

`previewPort` はサンドボックスで serve したサービスのブラウザから見たポート（env `PI_PREVIEW_PORT`。未設定はサービス リスナーの待受へ寄せて既定 4319。公開する配備は公開ポートを渡す）。`filePreviewPort` とは別で、常に返す。起動時に 1〜65535 の整数として検証し、不正値は起動を止める。稼働中かどうかを示す値ではなく、client は `location.hostname` と組み合わせて別タブの URL を作る。このポートを待つ BFF の 3 本目のリスナー（待受 env `PI_SERVICE_LISTEN_PORT`、既定 4319）が、受けた要求を `PI_SANDBOX_URL` のホストの 8080 へ転送し、キャッシュ ヘッダを `Cache-Control: no-store` に正規化する（転送の契約は [serve の契約](sandbox.md#serveサービスの公開と起動停止)）。

`modelOptions` は認証済みで利用可能なモデルのみ。設定 → モデル の「利用可能なモデル」を保存したときは、その許可リストと利用可能モデルの積だけになる（保存された既定モデルが許可リスト外なら `defaultModelError`、積が空なら `ready: false` と `設定 → モデル` を名指しした `error`。`errorCode` は互換のため `model_whitelist_empty` のまま）。能力情報（`supportsThinking` / `thinkingLevels`）は pi SDK の公開ヘルパー（`getSupportedThinkingLevels`）から得る。`defaultThinkingLevel` は `PI_THINKING` → `medium` の順で決まる。解決の詳細は [model-effort.md](model-effort.md)。

`versions` は実行中の SDK バージョンで、設定されている場合は `COMMIT_HASH` も含む。以前は `runtimeDiagnostics.versions` として返していたが、モデル診断の撤去に伴い health 直下へ移した（ランタイム初期化に失敗したときも `runtimeVersionInfo()` の値だけを返す）。プロバイダー別の集計と認証ソース（`environment` / `stored` / `runtime` / `fallback` / `models_json_key` / `models_json_command` / 未知の値は `unknown`）は [ランタイムのモデルカタログ](#ランタイムのモデルカタログ) が返す。認証状態のラベル、環境変数値、認証ファイル内容、生の認証エラーは health にもカタログにも含めない。

## ランタイムのモデルカタログ

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/runtime/models` | 設定 → モデル を開いたときに取得する、全カタログとプロバイダー認証状態 |

```json
{
  "catalogCount": 2,
  "availableCount": 2,
  "versions": { "piCodingAgent": "<version>", "piAi": "<version>", "commitHash": "…" },
  "providers": [
    {
      "provider": "<provider>",
      "auth": {
        "configured": true,
        "source": "environment",
        "environmentVariables": ["<ENV_VAR_NAME>"]
      },
      "models": [{ "id": "<id>", "name": "…", "available": true }]
    }
  ]
}
```

- `available` は SDK `getAvailable()` の結果（認証済みかつ SDK が利用可能とするモデル）。許可リストの適用前で、利用可能かどうかとは独立している
- 許可されているかどうかの正は [設定 → モデル](api-settings.md#利用可能なモデルとプロバイダーapiキー) の `allowedModels` だけで、この応答には whitelist 系のフィールドを持たせない
- 認証ソースと `environmentVariables` の公開範囲は `GET /api/health` と同じ。provider の内部設定、キー値、`auth.json` / `models.json` の内容は返さない
- 200: カタログ応答。0 件でも空の `providers` / count を返す
- 503: カタログを取得できない（ランタイム初期化失敗・`getAvailable()` の失敗）。生のエラーを含めず、`{ "error": "ランタイムのモデル情報を取得できません" }` を返す

カタログ全件は通常約 90KB（pi SDK の同梱版で変動）となるため、health には載せない。この API は設定画面を開いたとき、設定の変更後、それに [カタログ更新](api-settings.md#利用可能なモデルとプロバイダーapiキー) を押したときにだけ要求する（定期取得はしない）。

`sessionStore` は会話ストア、`appDb` はプロジェクト / エージェント定義を保存する SQLite の状態。`ok: false` のときは `error` に理由が入り、その保存先を読む API は 503 になる。`path` が `null` なのは永続化なしのとき（`sessionStore` は未設定、`appDb` はテストのメモリ DB）で、パス解決に失敗した `appDb` は `ok: false` と `path: null` の組み合わせになる。詳細は [persistence.md](persistence.md)。

## 実行環境（サンドボックス診断）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/runtime/environment` | 設定 → ランタイム の環境タブを開いたときと再読み込みで取得する、サンドボックス側の実行環境とコマンド |

```json
// 200 (connected)
{
  "state": "connected",
  "environment": {
    "os": "Debian GNU/Linux 13 (trixie)",
    "arch": "x86_64",
    "user": "node",
    "isRoot": false,
    "workspace": "/workspace"
  },
  "commands": [
    { "name": "curl", "version": "8.14.1" },
    { "name": "npm", "version": null }
  ],
  "landlock": { "state": "enabled", "abi": 6, "minAbi": 3 }
}
```

`state` は `connected` / `not_configured` / `unreachable` / `unauthorized` / `timeout` / `probe_failed` の 6 種で、`connected` 以外は `state` だけを返す（サンドボックスの情報は載せない）。検出できるコマンドの意味と allowlist、上限は [sandbox-api.md](sandbox-api.md#get-v1runtimeinfo) を参照する。

- 未接続でも HTTP 200 で返し、UI は HTTP ステータスや文言ではなく `state` で分岐する。BFF 自体の予期せぬエラーだけが既存のエラー処理（500）になる
- `connected` は認証付きの `GET /v1/runtime/info` が契約どおり応答し、情報の取得が完了した状態を指す。`bash` などのツールが実行可能であることは保証しない（`landlock` が `enabled` でなければ `bash` は実行できない。設定 → ランタイム の環境タブの実行環境カードに ABI と適用状態を出す）。個別コマンドのバージョンを取れなくても存在を確認できていれば `version: null` として `connected` を維持する
- `probe_failed` はサンドボックスへ到達したが応答が契約外 / 診断全体が不成立だった場合。HTTP 401 / 403 は `unauthorized`、接続失敗は `unreachable`、診断専用の期限（8 秒。接続待ちだけでなく**本文の受信完了まで**）の超過は `timeout`、接続情報が無いときは `not_configured`
- 非 2xx の本文は読まずに解放し、その完了は待たない（本文の `cancel()` が止まっても失敗分類は期限内に返す。待つと再読み込み中のままになる）
- サンドボックスの URL / 共有トークン / 内部エラーの詳細は応答に含めない（詳細は BFF のログに限る）
- `GET /api/health` の `ready`（モデル利用可能性）と `sandboxConfigured`（設定の有無）、`GET /api/runtime/models` の契約は変わらない。実行環境の「接続中」は認証付き診断 API の正常応答だけを示し、`sandboxConfigured` とは別の意味を持つ

## プロジェクト

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/projects` | プロジェクト一覧（作成順） |
| POST | `/api/projects` | プロジェクト作成（新規ディレクトリの作成 or 既存ディレクトリの登録） |
| DELETE | `/api/projects/:id` | 登録解除（配下セッションを破棄し、ディレクトリは残す） |

プロジェクトはワークスペース内のディレクトリで、アプリデータの SQLite へ保存する（再起動後も残る。詳細は [persistence.md](persistence.md)）。`cwd` はワークスペース root（`health.cwd` = `PI_APP_CWD`）相対の正規化パスで、root 自身（`""` / `"."`）は登録できない（未所属セッションの作業場所）。セッションの作業ディレクトリは所属プロジェクトの `cwd` を root と結合して決まる。プロジェクト所属でも同じスペースへの引き継ぎ（エージェント交代）はでき、未所属セッションだけは `POST /api/sessions/:id/move` で別スペースへも移れる（作業ディレクトリも移動先のパスへ移る。履歴は破棄される）。実行時の分離は「`write` / `edit` と `bash` の書き込みを作業ディレクトリへ閉じ込める」までで、読み取り・プロセス・ポートは共有する（詳細は [projects.md](projects.md#実行時の隔離ではない)）。

```json
{
  "projects": [
    { "id": "…", "name": "u7agent", "cwd": "projects/u7agent", "createdAt": 1700000000000 }
  ]
}
```

### `POST /api/projects`

```json
// request
{ "cwd": "projects/u7agent", "name": "u7agent", "create": false }
// response (201)
{ "project": { "id": "…", "name": "u7agent", "cwd": "projects/u7agent", "createdAt": 1700000000000 } }
```

- `cwd` は root 相対。`a//b/` や `./a` は正規化する。絶対パス・`..` を含むパス・空文字・root 自身・アプリの作業ディレクトリ `<appdir>`（現 `.u7agent`）自身と配下は 400。`cwd` 以外も含め body が契約外なら 400。
- `name` 省略時は `cwd` の basename。
- 同じ `cwd` の二重登録は 409（サンドボックスへは触らない）。
- `create: true` はサンドボックスで `mkdir -p` 相当を行う（親の存在は要求しない）。省略時は既存ディレクトリであることを確認する。新しい stat API は持たず、サンドボックスの `GET /v1/files` がディレクトリ以外で失敗する性質を使う。サンドボックス由来の 4xx（`Path not found` など）はステータス・文言ごとそのまま返る。
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定。

### `DELETE /api/projects/:id`

`{ "ok": true }` を返す。配下の live セッションは停止（実行中は abort）し、購読中の SSE へは所属が外れた `resync` が届く（`session_deleted` は送らない）。セッションの会話ストアと作業フォルダ、ワークスペースのディレクトリ（ファイル・Git リポジトリを含む）には触らない。未知の id は 404。
