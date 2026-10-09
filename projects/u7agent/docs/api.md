# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

例の JSON のモデルは `<provider>` / `<id>` のプレースホルダで示す。実値は環境の利用可能モデル（設定 → モデル の「利用可能なモデル」と available の積）で決まる。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

## 索引

| 領域 | エンドポイント | ドキュメント |
| --- | --- | --- |
| ヘルス | `GET /api/health` | このファイル |
| スペース | `GET/POST /api/spaces` | このファイル |
| ランタイムのモデルカタログ | `GET /api/runtime/models` | このファイル |
| 実行環境（サンドボックスの診断） | `GET /api/runtime/environment` | このファイル |
| ファイル一覧 | `GET /api/files` | このファイル |
| git ブランチ（作業フォルダ） | `GET /api/files/git` | このファイル |
| ファイル削除 | `DELETE /api/files` | このファイル |
| ファイルのリネーム | `POST /api/files/rename` | このファイル |
| テキストプレビュー | `GET /api/files/preview` | このファイル |
| HTML プレビュー（iframe 用。アプリ オリジン + プレビュー オリジンの 2 リスナー） | `GET /api/files/html/<root 相対>` | このファイル |
| 画像配信（raw） | `GET /api/files/raw` | このファイル |
| ダウンロード（ファイル / ZIP） | `GET /api/files/download`、`GET /api/files/download/check` | このファイル |
| プロジェクト | `GET/POST /api/projects`、`DELETE /api/projects/:id` | このファイル |
| セッション | `/api/sessions`、`/api/sessions/:id`、`/skills`、`/files`、`/messages`、`/questions/:toolCallId/answer`、`/events`、`/settings`、`/title`、`/stop`、`/compact` | [api-sessions.md](api-sessions.md) |
| 通知（Discord） | `GET/PUT /api/notifications`、`POST /api/notifications/test`、`PATCH /api/sessions/:id/notify` | [notifications.md](notifications.md) |
| アーカイブの除外名 | `GET/PUT/DELETE /api/settings/archive` | このファイル |
| プロバイダーAPIキーとメモ（設定 → モデル） | `GET /api/settings/models`、`PUT/DELETE /api/settings/models/:provider/key`、`PUT /api/settings/models/:provider/memo`、`POST /api/settings/models/:provider/resync`、`POST /api/settings/models/catalog/refresh` | このファイル |
| コンテンツ生成（設定 → コンテンツ生成） | `GET /api/settings/content`、`PUT /api/settings/content/image`、`PUT /api/settings/content/speech`、`PUT/DELETE /api/settings/content/key`、`POST /api/settings/content/image/catalog/refresh`、`POST /api/settings/content/speech/catalog/refresh` | このファイル、[image-generation.md](image-generation.md)、[speech-generation.md](speech-generation.md) |
| Web 検索の設定（設定 → Web 検索） | `GET/PUT /api/settings/web-search`、`PUT /api/settings/web-search/provider`、`PUT/DELETE /api/settings/web-search/providers/:provider/key` | このファイル、[web-search.md](web-search.md) |
| サービス（serve）の状態と起動・停止 | `GET /api/serve/status`、`POST /api/serve/start`、`POST /api/serve/stop` | このファイル、[sandbox.md](sandbox.md#serveサービスの公開と起動停止) |
| 作業フォルダの環境変数（作業環境 → 環境変数） | `GET/POST /api/secrets`、`GET/PUT/DELETE /api/secrets/:secretId` | このファイル、[secrets.md](secrets.md#作業フォルダの環境変数作業環境--環境変数) |
| エージェント / スキル | `/api/agents`、`/api/skills`、`/api/skills/files`、`/api/skills/session` | [api-catalog.md](api-catalog.md)、[api-sessions.md](api-sessions.md) |
| サンドボックス（内部） | `/v1/*`（BFF からは見えない） | [sandbox-api.md](sandbox-api.md) |

## スペース

- `GET /api/spaces` → `{ spaces: [{ id, name, createdAt }] }`。固定の通常 `{ id: "default", name: "通常", createdAt: 0 }` と保存済み追加スペースを返す。
- `POST /api/spaces` の本文 `{ name }` → 201 `{ space: { id, name, createdAt } }`。name は trim 後 1〜80 文字。内部 ID はサーバーが生成し、指定・改名・削除・リセット API は無い。DB 障害は一覧・作成とも 503。
- 会話作成は本文の `spaceId`、それ以外の会話 API・EventSource・プロジェクト API・作成前スキルプレビュー・作業環境の環境変数 / サービス API は query の `spaceId` を使う。欠落だけ `default` として扱う。不正 ID は 400、未知の追加スペースは 404。会話作成では query ではなく本文が正。
- 会話 ID と要求スペースの不一致は 404。descriptor / live record の所属で SDK 復元・作業生成・変更の前に拒否し、取得・履歴・設定・タイトル・通知・削除・停止・圧縮・送信・未送信・回答・添付・スキル・SSE に同じ規則を適用する。環境変数・サービスの `sessionId` にも適用する。
- 追加スペースでは `GET /api/projects` は `{ projects: [] }`、プロジェクト変更と `projectId` の利用は 400。通常のプロジェクト契約は変更しない。
- 共通カタログ・共通設定・汎用ファイル API、ランタイムのサービス診断 / 全体停止は分割しない。共有サービスの所有者は全会話から解決し、全体管理の応答は起動元の所属スペースも返す（会話のリンクの `?space=`）。`spaceId` は認証・権限ではなく、指定を変えれば別スペースを選べる。
- 通常の既知会話の削除・live 停止は DB 障害でも通し、壊れた JSONL の未ロード会話も SDK 復元なしで削除する。それ以外の既存 DB / 会話ストア障害の 503 契約は維持する。

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
  "versions": { "piCodingAgent": "1.0.3", "piAi": "1.0.3" },
  "sessionStore": { "path": "/var/lib/u7agent/sessions", "ok": true, "dirty": 0 },
  "appDb": { "path": "/var/lib/u7agent/sessions/u7agent.db", "ok": true },
  "archive": { "excludeNames": ["node_modules", ".venv", "…"] }
}
```

`archive.excludeNames` はダウンロード ZIP から落とす名前の**実効値**（[ダウンロード](#ダウンロード)）。設定ストア（[アーカイブの除外名](#アーカイブの除外名)）が唯一の決定点で、未設定なら既定の一覧、上書きされていればその一覧になる。UI は行にダウンロードを出すかの判定だけに使い、実際の拒否は `GET /api/files/download/check` が行う（このフィールドの形と意味は変えない）。

`filePreviewPort` は**ブラウザから見た**プレビュー オリジンのポート（env `PI_FILE_PREVIEW_PORT`、既定 4318）で、クライアントは別オリジンの iframe の URL をこれで組み立てる。BFF の待受は別 env `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で、prod は compose が `8017:4318` を publish して `PI_FILE_PREVIEW_PORT=8017` を渡す（値の解決と検証は起動時に 1 回で、1〜65535 の整数以外は起動が止まる。2 つの env は独立で、同じ値へ揃えるのは `pnpm dev` だけ）。

`previewPort` はサンドボックスで serve したサービスのブラウザから見たポート（env `PI_PREVIEW_PORT`。未設定はサービス リスナーの待受へ寄せて既定 4319、prod は 8016）。`filePreviewPort` とは別で、常に返す。起動時に 1〜65535 の整数として検証し、不正値は起動を止める。稼働中かどうかを示す値ではなく、client は `location.hostname` と組み合わせて別タブの URL を作る。このポートを待つ BFF の 3 本目のリスナー（待受 env `PI_SERVICE_LISTEN_PORT`、既定 4319）が、受けた要求を `PI_SANDBOX_URL` のホストの 8080 へ転送し、キャッシュ ヘッダを `Cache-Control: no-store` に正規化する（転送の契約は [serve の契約](sandbox.md#serveサービスの公開と起動停止)）。

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
  "versions": { "piCodingAgent": "1.0.3", "piAi": "1.0.3", "commitHash": "…" },
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
- 許可されているかどうかの正は [設定 → モデル](#利用可能なモデルとプロバイダーapiキー設定--モデル) の `allowedModels` だけで、この応答には whitelist 系のフィールドを持たせない
- 認証ソースと `environmentVariables` の公開範囲は `GET /api/health` と同じ。provider の内部設定、キー値、`auth.json` / `models.json` の内容は返さない
- 200: カタログ応答。0 件でも空の `providers` / count を返す
- 503: カタログを取得できない（ランタイム初期化失敗・`getAvailable()` の失敗）。生のエラーを含めず、`{ "error": "ランタイムのモデル情報を取得できません" }` を返す

カタログ全件は通常約 90KB（pi SDK の同梱版で変動）となるため、health には載せない。この API は設定画面を開いたとき、設定の変更後、それに [カタログ更新](#利用可能なモデルとプロバイダーapiキー設定--モデル) を押したときにだけ要求する（定期取得はしない）。

`sessionStore` は会話ストア、`appDb` はプロジェクト / カタログを保存する SQLite の状態。`ok: false` のときは `error` に理由が入り、その保存先を読む API は 503 になる。`path` が `null` なのは永続化なしのとき（`sessionStore` は未設定、`appDb` はテストのメモリ DB）で、パス解決に失敗した `appDb` は `ok: false` と `path: null` の組み合わせになる。詳細は [persistence.md](persistence.md)。

## 実行環境（サンドボックス診断）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/runtime/environment` | 設定 → ランタイムを開いたときと再読み込みで取得する、サンドボックス側の実行環境とコマンド |

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
- `connected` は認証付きの `GET /v1/runtime/info` が契約どおり応答し、情報の取得が完了した状態を指す。`bash` などのツールが実行可能であることは保証しない（`landlock` が `enabled` でなければ `bash` は実行できない。設定 → ランタイムの実行環境カードに ABI と適用状態を出す）。個別コマンドのバージョンを取れなくても存在を確認できていれば `version: null` として `connected` を維持する
- `probe_failed` はサンドボックスへ到達したが応答が契約外 / 診断全体が不成立だった場合。HTTP 401 / 403 は `unauthorized`、接続失敗は `unreachable`、診断専用の期限（8 秒。接続待ちだけでなく**本文の受信完了まで**）の超過は `timeout`、接続情報が無いときは `not_configured`
- 非 2xx の本文は読まずに解放し、その完了は待たない（本文の `cancel()` が止まっても失敗分類は期限内に返す。待つと再読み込み中のままになる）
- サンドボックスの URL / 共有トークン / 内部エラーの詳細は応答に含めない（詳細は BFF のログに限る）
- `GET /api/health` の `ready`（モデル利用可能性）と `sandboxConfigured`（設定の有無）、`GET /api/runtime/models` の契約は変わらない。実行環境の「接続中」は認証付き診断 API の正常応答だけを示し、`sandboxConfigured` とは別の意味を持つ

## ファイル一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files?path=<root 相対>` | 作業ディレクトリの一覧。`path` 省略時は root（`"."`） |
| DELETE | `/api/files?path=<root 相対>` | 通常ファイルの削除。成功は 204（本文なし） |
| DELETE | `/api/files?path=<root 相対>&recursive=true` | ディレクトリの削除（配下ごと）。成功は 204（本文なし） |

サンドボックスの `GET /v1/files` の応答を、そのまま DTO（`FileListing`）として返す。セッションに依存させない（`/api/sessions/:id/...` 配下に置かない）ため、セッションが無くても、APIキーが未設定で `/api/health` が `ready: false` でも開ける。

```json
{
  "path": "src",
  "entries": [
    { "name": "client", "type": "dir", "mtime": 1700000000000 },
    { "name": "README.md", "type": "file", "size": 1234, "mtime": 1700000000000 }
  ],
  "truncated": false
}
```

- 200: サンドボックスの一覧をそのまま返す。エントリの意味は [sandbox-api.md](sandbox-api.md#get-v1files) を参照
- 400 / 404: `path` が root 外へ解決される / 不正 / ディレクトリでない（400）、実在しない（404）。実在しない `path` は lexical な位置で判定するため、root 外を指す未作成パスは 404 ではなく 400 になる。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定。`{ "error": "サンドボックスが設定されていません (PI_SANDBOX_URL / PI_SANDBOX_TOKEN)" }`
- 502: サンドボックスへ到達できない / 認証失敗 / サンドボックス側のエラー / 契約外の応答（BFF が zod で検証して弾く）

client（`client/src/api.ts` の `getFiles`）は hc でこの契約を型として参照し、ディレクトリを展開したときにそのパスだけを取得する（遅延ロード）。並び順はサーバーが決めるため再ソートしない。自動更新は無く、画面の「再読み込み」で取り直す。`path` はワークスペース root 相対のままで、選択中セッションの配下を表示するときはクライアントがそのセッションの `cwd`（root 相対）を前置してパスを組み立てる。

この API はワークスペース root 相対で全体を見る（設定 → ファイル）が、モデルの `write` / `edit` の書き込み範囲はセッションの作業ディレクトリと `<root>/.agents/skills` に限られる（[projects.md](projects.md#write--edit-の書き込み範囲)）。

### 削除

`DELETE /api/files?path=<root 相対>` はサンドボックスへ委譲し、BFF はワークスペースに触らない。`recursive` が正確に文字列 `true` のときだけディレクトリの削除（`DELETE /v1/dirs?recursive=true`。[sandbox-api.md](sandbox-api.md#delete-v1dirs)）へ回し、省略時は従来どおり通常ファイルの削除（`DELETE /v1/files`）へ回す。`client/src/api.ts` の `deleteFile` / `deleteDirectory` は成功時に本文を読まない。

- 204: 削除した（本文なし）
- 400 / 404: root 外 / 不正 / 対象外（通常ファイル以外 / ディレクトリ以外） / symlink / ディレクトリを `recursive` なしで消そうとした（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- `recursive` が `true` 以外（`false` / `1` / `TRUE` / 空）や重複しているときは 400（`recursive must be exactly "true" when present`）で、サンドボックスへ要求を出さない
- 503 / 502: `GET /api/files` と同じ（未設定 / 到達不能・認証失敗・サンドボックス側のエラー）

出す導線は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の両方にある（[file-preview.md](file-preview.md#削除)）。

### リネーム

`POST /api/files/rename` は `{ path, name }`（どちらも string）を受け、サンドボックスの `POST /v1/files/rename`（[sandbox-api.md](sandbox-api.md#post-v1filesrename)）へ委譲する。BFF はワークスペースに触らない。`client/src/api.ts` の `renameEntry(path, name)` が呼び、応答は改名後のワークスペース root 相対パス。

```json
// request
{ "path": "uploads/nested/photo.png", "name": "shot.png" }

// response (200)
{ "path": "uploads/nested/shot.png", "name": "shot.png" }
```

- 200: サンドボックスの応答を検証（`FileRenameSchema`）してそのまま返す
- 400 / 404 / 409: 不正な名前 / root 外 / 不存在 / symlink（400）、実在しない（404）、同名の既存エントリ（409）。サンドボックス側の文言をそのまま返す。**同名は上書きも自動採番もしない**
- 400: `path` / `name` が string でない、JSON として壊れている（`Invalid request body` / `Request body must be valid JSON`）。サンドボックスへは要求しない
- 502: サンドボックスへ到達できない / 認証失敗 / 応答が契約外
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

出す導線は設定 → ファイル（ワークスペース root）のフォルダ行だけにある（[file-preview.md](file-preview.md#リネーム)）。API はファイル / ディレクトリの両方を受けるが、UI からファイルは改名できない。

### git ブランチ

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/git?path=<root 相対>` | `path`（省略時は root）のディレクトリが属する repo の HEAD |

サンドボックスの `GET /v1/files/git`（[sandbox-api.md](sandbox-api.md#get-v1filesgit)）の応答を DTO（`GitInfo`）として返す。`path` は一覧と同じワークスペース root 相対で、検証も同じ経路を通す。

```json
{ "branch": "feature/x" }
```

- 200: `branch` は HEAD のブランチ名で、detached HEAD は短縮 SHA。**repo の外・`git` の無い環境は `branch: null`** で、UI はチップを出さないだけにする（一覧の表示は止めない）。`Cache-Control: no-store`（再読み込みで取り直す）
- 400 / 404 / 502 / 503: パス検証とサンドボックス失敗の扱いは `GET /api/files` と同じ（400 root 外 / 404 実在しない / 502 到達不能・契約外の応答 / 503 未設定）

client（`client/src/api.ts` の `getGitInfo`）は作業フォルダの行が呼ぶ。取り直しの合図は一覧と同じ `reloadToken`（パネルの「再読み込み」と run の終了）で、失敗時は古い値を消してチップを出さない（[ui-layout.md](ui-layout.md#作業環境パネル)）。

## テキストプレビュー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/preview?path=<root 相対>` | テキストファイルの内容（UTF-8、2 MiB 以下） |

`{ "text": "内容" }` を返す（`Cache-Control: no-store`）。サンドボックスの `GET /v1/files/preview` に委譲し、root 内の通常ファイルのみ読み取る。この経路では HTML や Markdown も実行・レンダリングせずプレーンテキストとして返す（HTML の描画は `GET /api/files/html/<root 相対>` を使う）。

- 400 / 404: バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定
- 502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）

ファイル画面で選択するとタブとして開き、同じファイルの再選択はタブを増やさず表示だけを切り替える。タブは最大 8 枚で、超えると最も古いタブを閉じる。本文は表示中のタブの分だけ取得し、タブごとに保持する（切替では取り直さない）。「再読み込み」は開いているタブを保ったまま本文を捨てて取り直す。表示位置は本文の幅で決まり、狭いときはツリーの下、広いときはツリーの右に出る。行番号とシンタックスハイライトはクライアントの表示だけで、転送はプレーンテキストのまま（[file-preview.md](file-preview.md)）。

## HTML プレビュー

iframe の src になる HTML 文書と、その文書が相対参照するアセットを同じルートで配信する。パスは root 相対で `/` を含めてよく、クライアントはセグメント単位で percent encoding する。要求パスの拡張子で応答が分かれる。

| 要求（`GET /api/files/html/<path>`） | 応答 |
| --- | --- |
| `.html` / `.htm` | HTML 文書（UTF-8、2 MiB 以下）。CSP + `sandbox` 付きの `text/html` |
| 画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`） | `GET /v1/files/raw` を流用した生配信（100 MiB 以下） |
| 音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`） | 画像と同じ raw の生配信（100 MiB 以下。`Range` / 206 / 416 も同じ契約） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `GET /v1/files/preview` を流用した UTF-8 テキスト（2 MiB 以下） |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |
| パスなし（`/api/files/html`、`/api/files/html/`） | 404（HTML 文書は返さない） |

- 文書はサンドボックスの `GET /v1/files/preview` の応答を `text/html` としてそのまま返す（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）。HTML として開くかの判定は要求パスの拡張子で行い、本文の中身や拡張子は見ない
- テキストアセットも同じ `workspace.previewFile()` を通るため、バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外は 400、実在しない場合は 404（サンドボックス側の文言をそのまま返す）。画像 / 音声は raw の経路で `Content-Type` / `Content-Length` / `no-store` / `nosniff` を付けて返す
- 文書以外には CSP を付けず、拡張子から決めた Content-Type と `nosniff` で守る。`.svg` / HTML をアセットとして配らない（CSP の無い応答を同一オリジンで動かさない。この方針はプレビュー オリジンでも同じ）。動画 / フォントは対象外
- アセットの上限はテキスト（`.js` / `.mjs` / `.css` / `.json` / `.txt`）が 2 MiB、画像 / 音声の raw が 100 MiB。超えるテキストは 400、超える画像 / 音声は 413 でプレビューから読めない。`<script type="module">` はアプリ オリジン（オペーク）では CORS ヘッダが無いため読めず、プレビュー オリジンでは同じルートが `'self'` になるため読める
- 音声も画像と同じ生配信で、単一の `Range` を解釈して 206 / 416 を返す（シークで未バッファ位置へ飛んでも全体を取り直さない。契約は[画像配信（raw）](#画像配信raw)）
- 400 / 404: テキストプレビューと同じ分類。502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）。503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

iframe の中身は応答ヘッダと iframe 属性の両方で隔離する（親の CSP を継承させないために別ルートにする）。CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出し、既定は Lv2（相対アセットの `'self'` と `https:`）。

**同じルートが 2 つのオリジンに載る**。BFF はアプリと同じリスナー（`PORT`）と、プレビュー専用の 2 つ目のリスナー（待受は env `PI_FILE_PREVIEW_LISTEN_PORT`、ブラウザから見たポートは env `PI_FILE_PREVIEW_PORT`。既定はいずれも 4318）を立て、`previewApp` にはこのルート 1 本だけを載せる（書き込み系の API は載せない）。文書の CSP はリスナーごとに `sandbox` 段だけが変わり、アプリ オリジンは `sandbox allow-scripts`（オペークオリジン = 隔離）、プレビュー オリジンは `sandbox allow-scripts allow-same-origin allow-pointer-lock`（ストレージ有効モード）。どちらで開くかはクライアントのタブごとのスイッチが iframe の src と属性で選び（既定はプレビュー オリジン）、リクエストにはフラグを付けない（[file-preview.md](file-preview.md#html-プレビュー)）。

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:; media-src data: blob: 'self' https:; form-action 'none'
```

プレビュー オリジンの CSP はこの `sandbox` 段だけが `sandbox allow-scripts allow-same-origin allow-pointer-lock;` になる（`connect-src` はどちらにも足さない）。`PI_FILE_PREVIEW_PORT` が指すのはブラウザから見たポートで、待受は `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で独立に決まる。アプリ面の CSP は `frame-src 'self' http://*:<PI_FILE_PREVIEW_PORT>` を持ち、`'self'` は別オリジンを OFF にした（隔離へ戻した）ときの同一オリジン フレームのために残す。

文書のエラーは iframe の中で読めるように HTML 文書で返し、サンドボックス由来の文言は HTML エスケープする。アセットのエラーは JSON で返す（サブリソースに `text/html` を返さない）。方式と残リスクは [file-preview.md](file-preview.md)。

## 画像配信（raw）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/raw?path=<root 相対>` | 画像 / 音声の生配信（チャットの添付サムネイル・ファイル画面のプレビュー） |

サンドボックスの `GET /v1/files/raw` に委譲し、status と `Range` 系ヘッダを含めて応答をそのままストリームで返す。配信するのは画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`）と音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`）で、SVG / HTML は同一オリジンでスクリプトが動くため配信しない。判定は BFF とサンドボックスの両方で行う。**節の見出しはアンカー（`#画像配信raw`）を保つために据え置き**で、音声を含むようになったのは本文だけ（[sandbox-api.md](sandbox-api.md#get-v1filesraw)）。

- 200: 本文 + `Content-Type`（拡張子から決める）/ `Content-Length` / `Accept-Ranges: bytes` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 206: 単一の `Range`（`bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>`）を満たした部分本文 + `Content-Range: bytes <start>-<end>/<size>` / `Content-Length`（部分の長さ）/ `Accept-Ranges: bytes`。マルチパート / 複数レンジは対象外で、解釈できない `Range`（構文不正・`bytes` 以外の単位・複数レンジ）は無視して 200 を返す（RFC 9110）
- 416: 範囲として解釈できて満たせないときだけ（`bytes=100-` や 0 バイトへの `bytes=0-`、`bytes=-0`）+ `Content-Range: bytes */<size>`。本文は JSON のエラー
- 400 / 404 / 413: allowlist 外（`Not a servable file: …`）/ 未作成・root 外 / 上限（100 MiB）超過。サンドボックス側の文言をそのまま返す。**413 の文言は `File is too large (max … bytes)`**
- 502: サンドボックスへ到達できない / 認証失敗 / 本文が無い
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

クライアントは `client/src/api.ts` の `fileRawUrl(path, version?)` で URL を組み立て、`<img>` / `<audio>` の src に使う（取得はブラウザに任せ、本文は JSON に載せない。再生 / シークの要求はブラウザが `Range` を付けて送る）。version を指定したときだけ `&v=<version>` を付け、未指定なら従来の URL のままにする。`v` は同一 document 内の raw キャッシュを避けるためのクライアント側の版で、サーバーは版別のファイルを保持せず、常に現在のファイルを返す。

版は `client/src/hooks/useImageVersion.ts` の document 内で共有する単調な採番から取得する。各面は mount 時と更新トークン変更時だけ新しい版を割り当て、通常の再描画では同じ版を保つ。`runEndSeq` とパネルの手動更新回数は採番の**合図**であり、その数値を直接 `v` に使わない。独立カウンタの数値や mount ごとのゼロ戻りを URL に使うと、別の面や前の mount で取得済みの古い応答と衝突するため。採番は localStorage へ保存しない（新しい document では in-document キャッシュも作り直される）。StrictMode や破棄された描画で番号が飛んでも、再利用しないことを優先する。画像と音声は同じ版を共有する（どちらも raw の応答で、同じファイルを差し替えたら両方を取り直す）。

`path` はワークスペース root 相対で、セッションの作業フォルダ配下を表示するときは `fileTreeFetchPath(cwd, path)` で前置する。ファイルプレビューは `reloadToken`、assistant 本文の Markdown 画像は `ChatState.runEndSeq` を更新の合図に使う（[file-preview.md](file-preview.md#画像プレビュー)、[markdown.md](markdown.md#画像の-src-解決)）。添付はアップロードごとの一意名で不変なので、URL に版を付けない。

## ダウンロード

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/download?path=<root 相対>` | 通常ファイルは生バイト、ディレクトリは ZIP。どちらも `Content-Disposition: attachment` |
| GET | `/api/files/download/check?path=<root 相対>` | ダウンロードの見積り（種別 / 保存名 / 合計サイズ / エントリ数 / 除外名）。UI は先にこれを呼ぶ |

サンドボックスの `GET /v1/files/download` と `GET /v1/files/download/check` に委譲し、**BFF はワークスペースに触らない**。`download` は本文を JSON に載せずストリーム中継し（既存 `raw` と同じ）、`Content-Type` / `Content-Disposition` / `Content-Length` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` を付け直す。ファイル名の決定（`filename*=UTF-8''…` のエンコードを含む）と上限 / 除外の判定はサンドボックス側で、BFF は `Content-Disposition` を書き換えない（[sandbox-api.md](sandbox-api.md#get-v1filesdownload)）。

```json
// GET /api/files/download/check?path=src (200)
{
  "kind": "archive",
  "name": "src.zip",
  "bytes": 1042263,
  "entries": 209,
  "skipped": ["node_modules", "dist"]
}
```

- 200: ファイルは `application/octet-stream` + `Content-Length`、ZIP は `application/zip`（**長さを確定できないため `Content-Length` を付けない**）。HTML / SVG もここでは配る（`attachment` と `nosniff` でレンダリングさせない。raw の画像 allowlist は通さない）
- check の 200: サンドボックスの応答を `FileDownloadCheckSchema`（zod）で検証してそのまま返す。`kind` は `file` / `archive`、`entries` は ZIP のエントリ数（単体ファイルは 0）、`skipped` は除外規則で実際に落ちた名前
- 400 / 404 / 413: 除外名のディレクトリそのもの・root 外・形式不正（400）、不存在（404）、合計 100 MiB / 10,000 エントリ（単体ファイルも同じ 100 MiB）の超過（413）。サンドボックス側の文言をそのまま返す
- 502: サンドボックスへ到達できない / 認証失敗 / 本文が無い / check の応答が契約外
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

クライアントは `client/src/api.ts` の `getFileDownloadCheck(path)` で先に見積りを取り、`fileDownloadUrl(path)` の URL を `<a download>` のプログラム的クリックで開く（本文を `fetch` して保持しない。100 MiB のメモリを避け、ページ遷移もしない）。確認ダイアログ・エラー表示・行の出し分けは [file-preview.md](file-preview.md#ダウンロード)。

## アーカイブの除外名

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/archive` | 現在の一覧（実効値）と、未設定かどうか・上限を返す |
| PUT | `/api/settings/archive` | 一覧を丸ごと差し替える（上書き保存。空配列は「除外なし」） |
| DELETE | `/api/settings/archive` | 保存行を消して未設定へ戻す（既定名を保存し直さない） |

3 ルートとも同じ形を返す（204 にしないのは、画面が保存 / 既定に戻すの直後に新しい一覧をそのまま映すため）。アプリデータの SQLite を読むため、DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。

```json
// GET /api/settings/archive (200)
{
  "excludeNames": ["node_modules", ".venv", "dist"],
  "defaultExcludeNames": ["node_modules", ".venv", "dist", "…"],
  "overridden": false,
  "maxNames": 100,
  "maxNameLength": 200
}
```

- `excludeNames` は常に**実効値**（health の `archive.excludeNames` と同じ値）。`overridden: false` は行が無い = 既定の一覧を使っており、`true` は保存済みの一覧が正であることを表す（`[]` は「除外なし」で、既定へ戻した状態とは違う）
- `maxNames` / `maxNameLength` は画面が定数を二重持ちしないために返す（サーバーの検証と同じ値）
- PUT の本文は `{ "excludeNames": string[] }`（zod は形だけを見て、値の検証は store 側）。前後の空白は落とし、空文字は無視し、重複は先勝ちで畳む（大文字小文字はそのまま保持）
- 400: 形が違う本文、または 1 セグメント名として不正な名前（空・`.`・`..`・`/`・`\`・制御文字・`maxNameLength` 超）と `maxNames` 超。文言は `除外名に使えない名前があります: <name>` / `除外名は 100 件までです` で、画面はそのまま出す
- 保存 / リセットの応答も GET と同じ形で、`excludeNames` は保存後の実効値になる
- 変更は次のダウンロードから効く（BFF はリクエストごとに実効値をサンドボックスへ渡す。[sandbox-api.md](sandbox-api.md#get-v1filesdownload)）

## 利用可能なモデルとプロバイダーAPIキー（設定 → モデル）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/models` | 保存値（`allowedModels` / `defaultModel`）と provider 一覧（auth 状態 / managed / keyUpdatedAt / canSetApiKey / orphan / degraded）。純粋読取 |
| PUT | `/api/settings/models/allowed` | 利用可能なモデルとアプリ既定モデルの一括保存。body は `{ "allowedModels": ["<provider>/<id>"], "defaultModel": "<provider>/<id>" }`（どちらも `null` 可） |
| PUT | `/api/settings/models/:provider/key` | APIキーを登録（既存は上書き）。body は `{ "apiKey": "…" }` |
| PUT | `/api/settings/models/:provider/memo` | provider のメモを保存（`trim` して空なら行を削除）。body は `{ "memo": "…" }`（0..500 文字） |
| DELETE | `/api/settings/models/:provider/key` | この画面で登録したキーを削除 |
| POST | `/api/settings/models/:provider/resync` | degraded（保存済み・未反映）の回復。body 無し |
| POST | `/api/settings/models/catalog/refresh` | pi.dev の provider 別モデルカタログを取り直す。body 無し。取得失敗でも 200 で、理由は `catalogError` にだけ載せる |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。設計と残存リスクは [model-settings.md](model-settings.md) を正とする。

```json
// GET /api/settings/models (200)
{
  "runtimeAvailable": true,
  "allowedModels": ["<provider>/<id>"],
  "defaultModel": "<provider>/<id>",
  "ignoredEnvironmentVariables": ["PI_MODELS"],
  "providers": [
    {
      "provider": "<provider>",
      "name": "…",
      "auth": { "configured": true, "source": "runtime", "environmentVariables": [] },
      "managed": true,
      "keyUpdatedAt": 1730000000000,
      "canSetApiKey": true,
      "supportsOAuth": false,
      "orphan": false,
      "degraded": "apply",
      "memo": "個人アカウントの本番キー"
    }
  ]
}
```

- `allowedModels` は保存された許可リスト（`provider/model` の配列）で、`null` は「未設定 = 制限なし（全モデル）」。空配列で保存しても `null` へ正規化する。**許可されているかどうかの正はこのフィールドだけ**で、`GET /api/runtime/models` には同じ情報を載せない
- `defaultModel` は保存値（`null` は未設定 = 既定なし）。**実効値は `GET /api/health` の `model`** で、利用可能な候補があるのに未設定のときは `defaultModelUnset: true`、保存値が利用できないときは `defaultModelError` が付く
- `ignoredEnvironmentVariables` は、設定されていても読まなくなった環境変数（`PI_MODELS` / `PI_MODEL` / `PI_PROVIDER`）の名前。設定画面は移行のため削除を促す注記に使う
- `PUT /api/settings/models/allowed` は `provider/model` 形式・重複なし・カタログ内・既定が許可リスト内（制限なしのときはカタログ内）を検証し、400 で理由を返す（`カタログに無いモデルは指定できません: <provider>/<id>` など）。「許可リスト内だが未認証」の既定は保存できる（画面が警告と確認を出す）。応答は GET と同じ形 + `state: "applied"`
- `state: "applied"` は「アプリ DB へ保存し、公開 state（availableModels / modelOptions / selectedModel / resolveModel）を再計算した」ことを表す。SDK 呼び出しを含まないため `applied_unsynced` は無い。`null` の保存（未設定へ戻す）で行が消え、再起動後も維持される
- `managed` は `provider_credentials` に行がある（保存済みの希望状態）、`auth.source` は SDK の実効値（`runtime` / `environment` / `stored` …）、`degraded` はこのプロセスの SDK 反映が未完了（`apply` = 未適用 / `remove` = 削除未反映）を表す。3 つは独立で、混ぜて「使える」と見せない
- `keyUpdatedAt` はこの画面で登録したキー（`managed`）の最終保存時刻（epoch ms）。`managed` が false の provider と、v6 以前から残る移行前の行は `null`。上書き保存のたびに更新し、`resync` / 削除はこの時刻を変えない（削除後は行が無いため `null`）。最終使用はサーバーで持たず、クライアントが `GET /api/sessions` の `model` + `lastUsedAt` から集計する（[model-settings.md](model-settings.md#キーの棚卸し最終保存と最終使用)）
- `memo` は `provider_memos` の行と同じで、`null` = 未設定。**人間用の控えで、キーの登録有無（`managed`）とは独立**し、キーを削除しても残る。`canSetApiKey` が false の provider（ambient / keyless）にも書ける。メモだけの provider は `orphan: true` / `managed: false` として出る（カタログ外のバッジに落ちる）。メモは秘密情報ではないのでマスカーには登録しない（[secrets.md](secrets.md)）
- `canSetApiKey` は SDK の `auth.apiKey.login` の有無。false の provider（ambient / keyless）はこの画面からキーを登録できない
- `orphan: true` は現在のカタログに無い DB 行。`name` は provider id になり、削除だけできる（再同期はできない）
- キー値・ラベル・生の認証エラーは GET の応答に含めない。環境変数の**変数名**だけを `environmentVariables` に載せる（`GET /api/health` と同じ公開範囲）
- 変更系の本文は `{ "apiKey": "…" }` で、8..2048 文字。形が違う場合は 400（SDK / DB へ要求を出さない）
- `PUT /api/settings/models/:provider/memo` の本文は `{ "memo": "…" }` で、500 文字まで。`trim` して空なら行を消して `memo: null` に戻す。SDK 呼び出しを含まないため応答は常に `state: "applied"`。カタログに無い provider は credential 行かメモ行が既にあるときだけ受け付け、それ以外は 400（`このプロバイダーのメモは保存できません`）。500 文字超と形の違う本文は route の zod が 400 にする
- 200 の応答は GET と同じ形 + 必須の `state`。`applied` は反映まで成功、`applied_unsynced` は「保存済み・反映未完了」で、再同期 / 次回の変更 / 再起動で収束する
- 503 は `{ "error": "…", "state": "not_stored" }` で、何も保存されていないことを示す（DB 書込前の失敗、ランタイム初期化失敗など）。400 は `{ "error": "…" }` だけ。`PUT /api/settings/models/allowed` もランタイムが無いときは 503 `not_stored`（カタログ検証ができないため）
- 400: 未知の provider / `canSetApiKey` が false の provider への PUT、登録行が無い provider の DELETE、再同期の対象外（カタログに無く degraded も `remove` でない）、メモの対象外 provider。サンドボックスは使わない
- `POST /:provider/resync` は冪等。degraded でない provider に送っても現在の DB 希望状態を再適用して 200 を返す
- `POST /api/settings/models/catalog/refresh` は body 無し。pi.dev の provider 別カタログを取り直し、キー変更と同じロックの内側で「取得 → 公開 state の再計算 → 応答の組み立て」を 1 回ずつ行う。取得と再計算は同じ期限を共有し、期限到達後は読み取りを中断して公開 state を差し替えない（一覧と available は現在値のまま。ロックも期限以上には保持しない）
- 200 の応答は `GET /api/runtime/models` と同じ形 + `catalogError`（`null` なら今回の取得成功）。一部 provider の失敗・期限の abort・取得の例外・`PI_OFFLINE` でも 200 とし、一覧は更新できた範囲（期限で中断したときは更新前）を返す。設定を変えないため `state` を持たず、カタログそのものを返せないときだけ `GET /api/runtime/models` と同じ 503 を返す。失敗しても一覧は失わせない（分類と文言の契約は [model-settings.md](model-settings.md#モデルカタログの取得と更新)）

## Web 検索の設定（設定 → モデルの Web 検索タブ）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/web-search` | `enabled` / `provider`（既定）/ `providers[]`（id・名前・送信先・キーの要否・`configured`）/ `disabledMessage`。純粋読取で、行が無ければ `enabled: true` / `provider: "exa"`（既定）。APIキーの値は返さない |
| PUT | `/api/settings/web-search` | `{ enabled }`。保存した瞬間から、既存のセッションの次の `web_search` 呼び出しにも効く |
| PUT | `/api/settings/web-search/provider` | `{ provider }`。既定の provider を差し替える（`enabled` は保持）。未知の provider は 400 |
| PUT | `/api/settings/web-search/providers/:provider/key` | `{ apiKey }`。provider のキーを登録・上書き。キー不要 / 未知の provider は 400 |
| DELETE | `/api/settings/web-search/providers/:provider/key` | 行ごと削除して未設定へ戻す（冪等） |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。変更系は 503 に `state: "not_stored"` を付け、何も保存していないことを示す。トグルの意味、provider の抽象化、失敗時の契約は [web-search.md](web-search.md) を正とする。

```json
// GET /api/settings/web-search (200。行が無い = 既定（有効 / Exa）)
{
  "enabled": true,
  "provider": "exa",
  "providers": [
    { "id": "exa", "name": "Exa", "host": "mcp.exa.ai", "keyless": true, "configured": true },
    { "id": "tavily", "name": "Tavily", "host": "api.tavily.com", "keyless": false, "configured": false }
  ],
  "disabledMessage": "Web 検索は無効化されています。有効にするには 設定 → Web 検索 を開いてください。"
}

// PUT /api/settings/web-search (200。変更系は GET と同じ形 + state)
{ "enabled": false, "provider": "tavily", "providers": ["…"], "disabledMessage": "…", "state": "applied" }

// PUT /api/settings/web-search (503。何も保存していない)
{ "error": "Web 検索の設定をアプリデータ（SQLite）へ保存できませんでした", "state": "not_stored" }
```

## コンテンツ生成（設定 → モデルのコンテンツ生成タブ）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/content` | `configured` / `provider` / `runtimeAvailable` / `image` / `speech`（各 `model` / `models`（カタログ）/ `catalogSource` / `fetchedAt`。音声は `voice` も返す）。純粋読取で、APIキーは返さない |
| PUT | `/api/settings/content/image` | `{ provider, model }`。キーを保持したまま画像モデルの選択を更新（行が無ければ 400） |
| PUT | `/api/settings/content/speech` | `{ model, voice }`。キーと画像モデルを保持したまま音声モデル / ボイスを更新（行が無ければ 400） |
| PUT | `/api/settings/content/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/content/key` | 行ごと削除して未設定へ戻す（冪等） |
| POST | `/api/settings/content/image/catalog/refresh` | live カタログの再取得。常に 200 で `{ models, catalogSource, fetchedAt, catalogError }` を返す（失敗時も前の一覧を返し、`catalogError` に固定文言を載せる） |
| POST | `/api/settings/content/speech/catalog/refresh` | 音声カタログの再取得。応答は画像と同じ形 |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。モデル、保存先、ゲート、失敗分類は [image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md) を正とする。

```json
// GET /api/settings/content (200)
{
  "configured": true,
  "provider": "openrouter",
  "runtimeAvailable": true,
  "image": {
    "model": "openai/gpt-image-2",
    "models": [{ "provider": "openrouter", "id": "openai/gpt-image-2", "name": "OpenAI: GPT Image 2" }],
    "catalogSource": "live",
    "fetchedAt": 1740000000000
  },
  "speech": {
    "model": "google/gemini-3.8-flash-tts",
    "voice": "Zephyr",
    "models": [
      { "provider": "openrouter", "id": "google/gemini-3.8-flash-tts", "name": "Google: Gemini 3.8 Flash TTS", "voices": ["Zephyr", "Kore"] }
    ],
    "catalogSource": "live",
    "fetchedAt": 1740000000000
  }
}

// POST /api/settings/content/image/catalog/refresh (200。取得に失敗しても 200 で一覧は前のまま)
{
  "models": [{ "provider": "openrouter", "id": "openai/gpt-image-2", "name": "OpenAI: GPT Image 2" }],
  "catalogSource": "stored",
  "fetchedAt": 1740000000000,
  "catalogError": "モデル一覧の取得がタイムアウトしました"
}

// POST /api/settings/content/speech/catalog/refresh (200。形は画像と同じ)
{
  "models": [{ "provider": "openrouter", "id": "google/gemini-3.8-flash-tts", "name": "Google: Gemini 3.8 Flash TTS", "voices": ["Zephyr", "Kore"] }],
  "catalogSource": "default",
  "fetchedAt": null,
  "catalogError": "モデル一覧の取得が混雑しています（レート制限またはプロバイダー障害）"
}
```

- `configured` は `content_settings` に行があるか。`false` のとき `provider` / `image.model` / `speech.model` は `null`（行が無い = 未設定）
- `image` / `speech` は生成物の種類ごとの項目で、音声を足しても `image` の形は変えない
- `image.models` は live カタログ（OpenRouter の画像モデル API）で、UI はこの一覧からだけモデルを選べる。`catalogSource` は `live` / `stored` / `sdk` で、`live` 以外は取得に失敗した状態（`stored` = 前回の成功を DB キャッシュから、`sdk` = SDK 同梱）を表し、`fetchedAt` は最後に live を取得できた時刻（`sdk` は `null`）。キー値はどの応答にも含めない（[image-generation.md](image-generation.md#モデルカタログ)）
- `speech.models` は live カタログ（OpenRouter の音声モデル一覧 API）で、`voices` に話者の宣言を含む。`catalogSource` は `live` / `stored` / `default` で、`default` は「live もキャッシュも無く、同梱の既定 1 件を見ている」を表す。`voice` の空文字は「指定なし」（宣言が無いモデルで送らない）。`content_settings` の音声列が `NULL` の既存行は、既定モデルと先頭ボイスへフォールバックして返す（[speech-generation.md](speech-generation.md#モデルカタログ)）
- `runtimeAvailable` は `/api/settings/models` と同じく「SDK ランタイムの初期化に成功したか」。`false` のときキー登録は 503 `not_stored`（`retainSecret` が no-op になり保護できないため）。選択変更と削除は runtime に依存しない
- POST の `catalogError` は**今回の取得だけ**の結果で、`null` なら成功。失敗しても一覧と `catalogSource` は前のままで、503 にはしない（設定ではなくキャッシュの更新なので `state` も付けない）
- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映を持たないため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- 400: 行が無いのに PUT（`コンテンツ生成のAPIキーが未設定です。先にキーを登録してください`）、`openrouter` 以外の provider、カタログ外の model、画像 / 音声のカタログ外モデル、宣言があるモデルで宣言外のボイス、8..2048 文字外のキー、形が違う本文。音声カタログが `default` のときはカタログ照合をしない（[speech-generation.md](speech-generation.md#モデルカタログ)）
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`。削除すると行ごと消え、`generate_image` / `generate_speech` は次のセッション作成から公開されなくなる（既存セッションの execute は実行時にキー無効エラーを返す）

## サービス（serve）の状態と起動・停止

閲覧中の会話から見た、サンドボックスで公開中のサービス（旧称「成果物」）の状態と、起動 / 停止の操作。設計と表示規則は [sandbox.md](sandbox.md#serveサービスの公開と起動停止) と [ui-layout.md](ui-layout.md) を正とする。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/api/serve/status?sessionId=<id>` | 閲覧中の会話から見た状態（`sessionId` は必須） |
| POST | `/api/serve/start` | 起動（到達可なら他会話のプロセスを停止して置き換える） |
| POST | `/api/serve/stop` | 停止 |
| GET | `/api/serve/runtime/status` | 設定 → ランタイムから全体の状態を取得（会話 id は不要） |
| POST | `/api/serve/runtime/stop` | 設定 → ランタイムから現在公開中のサーバーを停止 |

作業ディレクトリはサーバーが会話ストアから解決する（client は `cwd` を送らない）。応答は 3 経路とも同じ形で、起動 / 停止の応答も実行後のプローブ結果と新しい世代を含む（押した時点で UI の状態が確定する）。

```json
{
  "reachable": true,
  "owner": { "kind": "mine", "title": "サービスを作る会話" },
  "generation": "8f3c1d2e",
  "command": { "cwd": "projects/foo", "command": "pnpm dev" },
  "secretGeneration": "0f1e2d3c4b5a6978"
}
```

- `reachable`: プローブ（BFF → サンドボックスの listen ポート 8080 への TCP connect）の結果。HTTP は叩かないので、500 を返すアプリでも到達可なら `true`。**「稼働中」は閲覧中の会話のサービスが公開されている意味**で、ポートの空き状況ではない。ブラウザからの HTTP は別経路（BFF のサービス リスナー → サンドボックスの 8080 への転送）で、こちらは到達できないときに 502 を返す。
- `owner.kind`: `mine`（閲覧中の会話が所有者）/ `other`（他会話が所有者）/ `unknown`（到達可だが記録と一致しない）/ `none`（到達不可で所有者なし）。所有者は記録（PID + 起動時刻）と「いま待受しているプロセス」の照合で決め、記録があるだけでは所有者とみなさない。`mine` / `other` のときだけ `title` が載る。
- `generation`: 置き換えの再照合用の不透明な値。起動のたびに変わり、**記録を残したまま生の bash で待受プロセスが入れ替わった場合も変わる**（起動世代と、いま待受しているソケットの inode を合わせたハッシュ）。到達不可（置き換える対象が無い）は `null`。
- `command`: **閲覧中の会話の作業ディレクトリ**の成功実績（`serve_commands`）。無ければ `null` で、他会話の実績は返さない。
- `secretGeneration`: 起動時に解決した環境変数（作業環境 → 環境変数）の世代。記録と待受プロセスが一致するときだけ返し、`GET /api/secrets` の `generation` と比べる（[作業フォルダの環境変数](#作業フォルダの環境変数作業環境--環境変数)）。記録が無い / この項目より前の記録は `null`。

`POST /api/serve/start` の body は `{ sessionId, command?, generation? }`。`command` はエージェントの `serve` ツールだけが渡し（GUI は実績を使う）、省略時はその作業ディレクトリの実績を使う。**実績の解決と検証は置き換えの停止より先**で、実績が無ければ既存のサービスを止めずに 400 を返す。`generation` は確認した状態の値で、実行時に変わっていれば 409（UI は新しい状態で確認をやり直す）。`POST /api/serve/stop` の body は `{ sessionId, generation? }`。

エラー: 所有者以外の停止は 403、待受 PID を特定できないときと照合不一致は 409、起動が期限（10 秒）内に到達可にならないとき・到達した待受プロセスがその起動に由来しないとき・停止の解放を確認できないときは 502、サンドボックス未設定は 503、アプリデータ（実績）が使えないときは 503（変更系は `state: "not_stored"` を付ける）。**プローブやサンドボックス呼び出しの失敗は 502 / 503 で返し、`reachable: false` へ丸めない**（UI はリンクも操作も出さない）。

### ランタイムからの全体管理

`GET /api/serve/runtime/status` と `POST /api/serve/runtime/stop` の応答は `{ reachable, owner, generation, command }`。`owner` は記録と待受ソケットが一致し、会話ストアに起動元が残っているときだけ `{ sessionId, title, spaceId }`、それ以外は `null`。`spaceId` は起動元の所属スペースで、引けないときは載せない（リンクの `?space=` に使う）。`command` は一致する稼働記録の `{ cwd, command }` で、会話ごとの成功実績は使わない。到達不可なら `owner` / `generation` / `command` はすべて `null`。記録のない bash 起動は起動元不明とし、推測した会話リンクを返さない。

全体停止の body は `{ generation: "確認した値" }`（空・null・省略・余分な項目は 400）。会話の選択と所有者に依存せず停止でき、会話未作成・起動元不明・削除済みの会話が起動したサービスも対象。既存の会話からの停止権限は変更しない。全体停止も同じロック・世代照合・待受 PID の特定・ポート解放確認を通す。確認後の入れ替わりは 409 で拒否し、自動再試行はしない。同一オリジンの書き込み検査も適用する。

ランタイム画面は4秒ごとに取得し、失敗時はリンクと停止操作を隠す。稼働中なら公開ポートを別タブで開け、既知の起動元へ `/s/<sessionId>?space=<spaceId>` で移動できる（所属が引けないときは `?space=` なしで、保存値で解決させる）。通常クリックでも起動元の会話だけを取得し、削除済みなどで開けない場合は別の会話へフォールバックせず、未選択のチャットにリンク先を開けなかった旨を表示する。待機中にユーザーが別の会話を選んだ場合はその選択を優先し、失敗通知も出さない。停止には確認ダイアログを出す。公開枠は既存どおり8080の1本で、任意ポートのサーバー一覧や自動再起動は追加しない。

## 作業フォルダの環境変数（作業環境 → 環境変数）

作業フォルダ（cwd）単位の名前と値。種別は平文で保存する `variable` と、AEAD で暗号化する `secret`。設計（名前 / 値の規則、注入経路、保証範囲）は [secrets.md](secrets.md#作業フォルダの環境変数作業環境--環境変数) を正とする。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/api/secrets?sessionId=<id>` / `?projectId=<id>` | 一覧（名前・種別・更新時刻・世代・プロジェクト所属か） |
| POST | `/api/secrets` | 登録（body: `{ sessionId? , projectId?, kind, name, value }`） |
| GET | `/api/secrets/:secretId?sessionId=<id>` | 変更フォーム用の 1 件（`value` は**変数のときだけ**入る） |
| PUT | `/api/secrets/:secretId` | 値の上書き（body: `{ sessionId?, projectId?, value }`。名前と種別は変えられない） |
| DELETE | `/api/secrets/:secretId?sessionId=<id>` | 削除 |

要求元は会話（`sessionId`）か、まだ会話が無いプロジェクト起点の新規会話（`projectId`）の**どちらか一方**。cwd への解決はサーバーだけが行い、行の `cwd` と照合する（他会話の `secret_id` を指定しても 404）。`sessionId` と `projectId` の両方 / どちらも無い指定は 400、未知の会話 / プロジェクトは 404。

```json
{
  "items": [
    { "secretId": "…", "name": "DATABASE_URL", "kind": "secret", "updatedAt": 1770000000000 },
    { "secretId": "…", "name": "NODE_ENV", "kind": "variable", "updatedAt": 1770000000000 }
  ],
  "generation": "0f1e2d3c4b5a6978",
  "projectScoped": true
}
```

- **シークレットの値はどの応答にも載らない。** 変更フォーム用の `GET /api/secrets/:secretId` だけが `value` を持ち、それも変数のときだけ
- `generation` は変更のたびに変わる短いハッシュ（名前 → `secret_id` / 更新世代）。`GET /api/serve/status` の `secretGeneration` と比べると「再起動で反映される変更がある」と分かる（UI はタブ上部の説明 1 行まで）
- `projectScoped` は cwd が登録プロジェクトのディレクトリか（UI の「このプロジェクトの設定です」の根拠）
- 変更系は 200 で `{ item, trimmed, generation }` を返す（`trimmed` は前後の空白 / 改行を除去したか。削除は `{ removed, generation }`）

エラー: 名前 / 値の規則違反は 400、同名の重複は 409、別の cwd / 存在しない `secretId` は 404、シークレットで master key が未設定 / 宣言が壊れている / 復号できないときは 503（`state: "not_stored"`）。アプリデータが使えないときも 503（変更系は `state: "not_stored"`）。

## セッションへのファイルアップロード

`POST /api/sessions/:id/files?name=<ファイル名>` は選択時の即時アップロードで、既定のアップロード先は `<appdir>/uploads/<sessionId>/`（プロジェクトのリポジトリ内には作らない）。JSON ではなく raw ストリームで受け、`bodyGuard`（既定 64 KiB の body 上限と text 化）より前に登録する。仕様と上限は [api-sessions.md](api-sessions.md#post-apisessionsidfiles)、保存の規則は [session-files.md](session-files.md#添付ファイルチャットからのアップロード) を参照する。

## プロジェクト

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/projects` | プロジェクト一覧（作成順） |
| POST | `/api/projects` | プロジェクト作成（新規ディレクトリの作成 or 既存ディレクトリの登録） |
| DELETE | `/api/projects/:id` | 登録解除（配下セッションを破棄し、ディレクトリは残す） |

プロジェクトはワークスペース内のディレクトリで、アプリデータの SQLite へ保存する（再起動後も残る。詳細は [persistence.md](persistence.md)）。`cwd` はワークスペース root（`health.cwd` = `PI_APP_CWD`）相対の正規化パスで、root 自身（`""` / `"."`）は登録できない（未所属セッションの作業場所）。セッションの作業ディレクトリは所属プロジェクトの `cwd` を root と結合して決まり、作成後に変えることはできない。実行時の分離は「`write` / `edit` と `bash` の書き込みを作業ディレクトリへ閉じ込める」までで、読み取り・プロセス・ポートは共有する（詳細は [projects.md](projects.md#実行時の隔離ではない)）。

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
