# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

例の JSON のモデルは `<provider>` / `<id>` のプレースホルダで示す。実値は環境の利用可能モデル（`PI_MODELS` の whitelist と available の積）で決まる。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

## 索引

| 領域 | エンドポイント | ドキュメント |
| --- | --- | --- |
| ヘルス | `GET /api/health` | このファイル |
| ランタイムのモデルカタログ | `GET /api/runtime/models` | このファイル |
| ファイル一覧 | `GET /api/files` | このファイル |
| ファイル削除 | `DELETE /api/files` | このファイル |
| ファイルのリネーム | `POST /api/files/rename` | このファイル |
| テキストプレビュー | `GET /api/files/preview` | このファイル |
| HTML プレビュー（iframe 用） | `GET /api/files/html/<root 相対>` | このファイル |
| 画像配信（raw） | `GET /api/files/raw` | このファイル |
| ダウンロード（ファイル / ZIP） | `GET /api/files/download`、`GET /api/files/download/check` | このファイル |
| プロジェクト | `GET/POST /api/projects`、`DELETE /api/projects/:id` | このファイル |
| セッション | `/api/sessions`、`/api/sessions/:id`、`/skills`、`/files`、`/messages`、`/events`、`/settings`、`/stop` | [api-sessions.md](api-sessions.md) |
| 通知（Discord） | `GET/PUT /api/notifications`、`POST /api/notifications/test`、`PATCH /api/sessions/:id/notify` | [notifications.md](notifications.md) |
| アーカイブの除外名 | `GET/PUT/DELETE /api/settings/archive` | このファイル |
| エージェント / スキル | `/api/agents`、`/api/skills`、`/api/skills/files`、`/api/skills/session` | [api-catalog.md](api-catalog.md)、[api-sessions.md](api-sessions.md) |
| サンドボックス（内部） | `/v1/*`（BFF からは見えない） | [sandbox-api.md](sandbox-api.md) |

## 型の共有

- `server/src/app.ts` はルートをチェーン形式で定義し `AppType` を export。client は `hc<AppType>(location.origin)` で型付きクライアントを構築する（`client/src/api.ts`）。SSE は型付け対象外で、`EventEntry` のみ server から型 import する。
- ルートチェーン以外の実装は `server/src/routes/`（ハンドラ）、`server/src/http.ts`（body ガード / エラー変換）、`server/src/static.ts`（静的配信 / CSP）、`server/src/bootstrap.ts`（pi ランタイムと store の組み立て）に分かれている。ルートの追加・変更は `app.ts` のチェーンと該当する route モジュールを読めば済む。
- server / client の両 tsconfig は `moduleResolution: bundler` + noEmit。server は tsx で実行するため拡張子なし import で統一し、client は workspace package `server` のソースを型として直接参照する。

## ヘルスチェック

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | pi ランタイムの状態（`ready` / `model` / `modelOptions` / `defaultThinkingLevel` / `cwd`）と小さいモデル診断サマリ。認証が無い場合は `errorCode: "authentication_required"`、`PI_MODELS` の whitelist と利用可能モデルが交差しない場合は `errorCode: "model_whitelist_empty"` |

`ready` は「ランタイムが使え、利用可能モデルが 1 つ以上ある」の意で、アプリ既定モデル（`model`）が使えるかとは独立している。`model` はあくまでアプリ既定（新規セッションで明示も定義も無いときに使う値）で、チャットごとの実効モデルではない。チャットの実効モデルはセッションの payload / 一覧の `model` を参照する。明示 `PI_MODEL` が利用不能でも候補が他にあれば `ready: true` と `defaultModelError` を返し、別モデルへは自動で切り替えない。`sandboxConfigured` は `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が揃っているか（未設定ならセッション作成が 503 になる）を示す。

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
  "defaultModelError": "指定された既定モデルは利用できません: openai/ghost",
  "runtimeDiagnostics": {
    "status": "available",
    "whitelistConfigured": true,
    "catalogCount": 1495,
    "whitelistCount": 3,
    "availableCount": 8,
    "piModels": [],
    "providers": [],
    "versions": { "piCodingAgent": "0.87.1", "piAi": "0.87.1" }
  },
  "sessionStore": { "path": "/var/lib/u7agent/sessions", "ok": true, "dirty": 0 },
  "appDb": { "path": "/var/lib/u7agent/sessions/u7agent.db", "ok": true },
  "archive": { "excludeNames": ["node_modules", ".venv", "…"] }
}
```

`archive.excludeNames` はダウンロード ZIP から落とす名前の**実効値**（[ダウンロード](#ダウンロード)）。設定ストア（[アーカイブの除外名](#アーカイブの除外名)）が唯一の決定点で、未設定なら既定の一覧、上書きされていればその一覧になる。UI は行にダウンロードを出すかの判定だけに使い、実際の拒否は `GET /api/files/download/check` が行う（このフィールドの形と意味は変えない）。

`modelOptions` は認証済みで利用可能なモデルのみ。`PI_MODELS` を指定したときは、その whitelist と利用可能モデルの積だけになる（`PI_MODEL` が whitelist 外なら `defaultModelError`、積が空なら `ready: false` と PI_MODELS を名指しした `error`）。能力情報（`supportsThinking` / `thinkingLevels`）は pi SDK の公開ヘルパー（`getSupportedThinkingLevels`）から得る。`defaultThinkingLevel` は `PI_MODEL` の末尾指定 → `PI_THINKING` → `medium` の優先順位で決まる。解決の詳細は [model-effort.md](model-effort.md)。

`runtimeDiagnostics` は全カタログを含めない集計で、カタログ数・whitelist 収載数・whitelist 適用前の利用可能数と、明示した `PI_MODEL` / `PI_MODELS` の各入力要素を返す。`PI_MODELS` の判定は入力順と重複を保つ。モデル参照の判定は「未知のプロバイダー → カタログ外 → 未認証 → whitelist 対象外 → 利用可能」の優先順で、認証済みでも SDK の利用可能一覧に無いモデルは `not_available` になる。プロバイダー別の数値と認証状態は、`PI_MODEL` / `PI_MODELS` で参照されたプロバイダーと認証済みプロバイダーだけを含む。それ以外の内訳は返さない。

認証ソースは `environment` / `stored` / `runtime` / `fallback` / `models_json_key` / `models_json_command` を表し、将来 SDK が返す未知の値は `unknown` にする。`environmentVariables` に含めるのは環境変数名として検証できた名前だけで、認証状態のラベル、環境変数値、認証ファイル内容、生の認証エラーは含めない。SDK バージョンと、設定されている場合の `COMMIT_HASH` も表示する。ランタイム初期化または診断の取得に失敗した場合は `runtimeDiagnostics.status: "unavailable"` とし、既存の health エラーや `ready` の意味は変更しない。

## ランタイムのモデルカタログ

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/runtime/models` | 設定 → ランタイムを開いたときに取得する、全カタログとプロバイダー認証状態 |

```json
{
  "whitelistConfigured": true,
  "catalogCount": 2,
  "whitelistCount": 1,
  "availableCount": 2,
  "versions": { "piCodingAgent": "0.87.1", "piAi": "0.87.1", "commitHash": "…" },
  "providers": [
    {
      "provider": "<provider>",
      "auth": {
        "configured": true,
        "source": "environment",
        "environmentVariables": ["<ENV_VAR_NAME>"]
      },
      "models": [
        { "id": "<id>", "name": "…", "available": true, "inWhitelist": true }
      ]
    }
  ]
}
```

- `available` は whitelist 適用前の SDK `getAvailable()` の結果、`inWhitelist` はカタログの whitelist 収載状態。両者は独立している。whitelist 未指定時は全モデルで `inWhitelist: true` とし、`whitelistConfigured: false` で制限なしを示す
- `whitelistCount` はカタログとの一致モデル数で、whitelist 入力の重複は数えない。`availableCount` は whitelist 適用前の件数
- 認証ソースと `environmentVariables` の公開範囲は `GET /api/health` と同じ。provider の内部設定、キー値、`auth.json` / `models.json` の内容は返さない
- 200: カタログ応答。0 件でも空の `providers` / count を返す
- 503: ランタイムまたは診断情報が利用できない。生のエラーを含めず、`{ "error": "ランタイムのモデル情報を取得できません" }` を返す

カタログ全件は通常約 90KB（pi SDK の同梱版で変動）となるため、health には載せない。この API は設定画面を開いたときにだけ要求する。

`sessionStore` は会話ストア、`appDb` はプロジェクト / カタログを保存する SQLite の状態。`ok: false` のときは `error` に理由が入り、その保存先を読む API は 503 になる。`path` が `null` なのは永続化なしのとき（`sessionStore` は未設定、`appDb` はテストのメモリ DB）で、パス解決に失敗した `appDb` は `ok: false` と `path: null` の組み合わせになる。詳細は [persistence.md](persistence.md)。

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

## テキストプレビュー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/preview?path=<root 相対>` | テキストファイルの内容（UTF-8、256 KiB 以下） |

`{ "text": "内容" }` を返す（`Cache-Control: no-store`）。サンドボックスの `GET /v1/files/preview` に委譲し、root 内の通常ファイルのみ読み取る。この経路では HTML や Markdown も実行・レンダリングせずプレーンテキストとして返す（HTML の描画は `GET /api/files/html/<root 相対>` を使う）。

- 400 / 404: バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定
- 502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）

ファイル画面で選択するとタブとして開き、同じファイルの再選択はタブを増やさず表示だけを切り替える。タブは最大 8 枚で、超えると最も古いタブを閉じる。本文は表示中のタブの分だけ取得し、タブごとに保持する（切替では取り直さない）。「再読み込み」は開いているタブを保ったまま本文を捨てて取り直す。表示位置は本文の幅で決まり、狭いときはツリーの下、広いときはツリーの右に出る。行番号とシンタックスハイライトはクライアントの表示だけで、転送はプレーンテキストのまま（[file-preview.md](file-preview.md)）。

## HTML プレビュー

iframe の src になる HTML 文書と、その文書が相対参照するアセットを同じルートで配信する。パスは root 相対で `/` を含めてよく、クライアントはセグメント単位で percent encoding する。要求パスの拡張子で応答が分かれる。

| 要求（`GET /api/files/html/<path>`） | 応答 |
| --- | --- |
| `.html` / `.htm` | HTML 文書（UTF-8、256 KiB 以下）。CSP + `sandbox` 付きの `text/html` |
| 画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`） | `GET /v1/files/raw` を流用した生配信（100 MiB 以下） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `GET /v1/files/preview` を流用した UTF-8 テキスト（256 KiB 以下） |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |
| パスなし（`/api/files/html`、`/api/files/html/`） | 404（HTML 文書は返さない） |

- 文書はサンドボックスの `GET /v1/files/preview` の応答を `text/html` としてそのまま返す（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）。HTML として開くかの判定は要求パスの拡張子で行い、本文の中身や拡張子は見ない
- テキストアセットも同じ `workspace.previewFile()` を通るため、バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外は 400、実在しない場合は 404（サンドボックス側の文言をそのまま返す）。画像は raw の経路で `Content-Type` / `Content-Length` / `no-store` / `nosniff` を付けて返す
- 文書以外には CSP を付けず、拡張子から決めた Content-Type と `nosniff` で守る。`.svg` / HTML をアセットとして配らない（同一オリジンでスクリプトを動かさない）
- アセットの本文は 256 KiB が上限で、超える `.js` / `.css` はプレビューから読めない。`<script type="module">` は CORS ヘッダが無いため読めない（classic script のみ）
- 400 / 404: テキストプレビューと同じ分類。502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）。503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

iframe の中身は応答ヘッダだけで隔離する（親の CSP を継承させないために別ルートにする）。CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出し、既定は Lv2（相対アセットの `'self'` と `https:`）。iframe 属性は段階に関わらず `sandbox="allow-scripts"` 固定。

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:; media-src data: blob: 'self' https:; form-action 'none'
```

文書のエラーは iframe の中で読めるように HTML 文書で返し、サンドボックス由来の文言は HTML エスケープする。アセットのエラーは JSON で返す（サブリソースに `text/html` を返さない）。方式と残リスクは [file-preview.md](file-preview.md)。

## 画像配信（raw）

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/raw?path=<root 相対>` | 画像の生配信（チャットの添付サムネイル・ファイル画面のプレビュー） |

サンドボックスの `GET /v1/files/raw` に委譲し、応答をそのままストリームで返す。配信するのは画像だけで、allowlist は `png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`（SVG / HTML は同一オリジンでスクリプトが動くため配信しない）。判定は BFF とサンドボックスの両方で行う。

- 200: 本文 + `Content-Type`（拡張子から決める）/ `Content-Length` / `Cache-Control: no-store` / `X-Content-Type-Options: nosniff`
- 400 / 404 / 413: allowlist 外（`Not a servable image: …`）/ 未作成・root 外 / 上限（100 MiB）超過。サンドボックス側の文言をそのまま返す
- 502: サンドボックスへ到達できない / 認証失敗 / 本文が無い
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

クライアントは `client/src/api.ts` の `fileRawUrl(path)` で URL を組み立て、`<img>` の src に使う（取得はブラウザに任せ、本文は JSON に載せない）。`path` はワークスペース root 相対で、セッションの作業フォルダ配下を表示するときは `fileTreeFetchPath(cwd, path)` で前置する。表示は [file-preview.md](file-preview.md)。

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

## セッションへのファイルアップロード

`POST /api/sessions/:id/files?name=<ファイル名>` は選択時の即時アップロードで、既定のアップロード先は `<appdir>/uploads/<sessionId>/`（プロジェクトのリポジトリ内には作らない）。JSON ではなく raw ストリームで受け、`bodyGuard`（既定 64 KiB の body 上限と text 化）より前に登録する。仕様と上限は [api-sessions.md](api-sessions.md#post-apisessionsidfiles)、保存の規則は [session-files.md](session-files.md#添付ファイルチャットからのアップロード) を参照する。

## プロジェクト

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/projects` | プロジェクト一覧（作成順） |
| POST | `/api/projects` | プロジェクト作成（新規ディレクトリの作成 or 既存ディレクトリの登録） |
| DELETE | `/api/projects/:id` | 登録解除（配下セッションを破棄し、ディレクトリは残す） |

プロジェクトはワークスペース内のディレクトリで、アプリデータの SQLite へ保存する（再起動後も残る。詳細は [persistence.md](persistence.md)）。`cwd` はワークスペース root（`health.cwd` = `PI_APP_CWD`）相対の正規化パスで、root 自身（`""` / `"."`）は登録できない（未所属セッションの作業場所）。セッションの作業ディレクトリは所属プロジェクトの `cwd` を root と結合して決まり、作成後に変えることはできない。実行時の隔離は行わない（`cwd` はツールのパス解決の起点のみ。詳細は [projects.md](projects.md)）。

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
