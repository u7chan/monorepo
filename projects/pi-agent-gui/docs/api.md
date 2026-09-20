# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

## 索引

| 領域 | エンドポイント | ドキュメント |
| --- | --- | --- |
| ヘルス | `GET /api/health` | このファイル |
| ファイル一覧 | `GET /api/files` | このファイル |
| テキストプレビュー | `GET /api/files/preview` | このファイル |
| HTML プレビュー（iframe 用） | `GET /api/files/html` | このファイル |
| 画像配信（raw） | `GET /api/files/raw` | このファイル |
| プロジェクト | `GET/POST /api/projects`、`DELETE /api/projects/:id` | このファイル |
| セッション | `/api/sessions`、`/api/sessions/:id`、`/files`、`/messages`、`/events`、`/settings`、`/stop` | [api-sessions.md](api-sessions.md) |
| エージェント / スキル | `/api/agents`、`/api/skills` | [api-catalog.md](api-catalog.md) |
| サンドボックス（内部） | `/v1/*`（BFF からは見えない） | [sandbox-api.md](sandbox-api.md) |

## 型の共有

- `server/src/app.ts` はルートをチェーン形式で定義し `AppType` を export。client は `hc<AppType>(location.origin)` で型付きクライアントを構築する（`client/src/api.ts`）。SSE は型付け対象外で、`EventEntry` のみ server から型 import する。
- ルートチェーン以外の実装は `server/src/routes/`（ハンドラ）、`server/src/http.ts`（body ガード / エラー変換）、`server/src/static.ts`（静的配信 / CSP）、`server/src/bootstrap.ts`（pi ランタイムと store の組み立て）に分かれている。ルートの追加・変更は `app.ts` のチェーンと該当する route モジュールを読めば済む。
- server / client の両 tsconfig は `moduleResolution: bundler` + noEmit。server は tsx で実行するため拡張子なし import で統一し、client は workspace package `server` のソースを型として直接参照する。

## ヘルスチェック

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | pi ランタイムの状態（`ready` / `model` / `modelOptions` / `defaultThinkingLevel` / `cwd`）。認証が無い場合は `errorCode: "authentication_required"`、`PI_MODELS` の whitelist と利用可能モデルが交差しない場合は `errorCode: "model_whitelist_empty"` |

`ready` は「ランタイムが使え、利用可能モデルが 1 つ以上ある」の意で、アプリ既定モデル（`model`）が使えるかとは独立している。`model` はあくまでアプリ既定（新規セッションで明示も定義も無いときに使う値）で、チャットごとの実効モデルではない。チャットの実効モデルはセッションの payload / 一覧の `model` を参照する。明示 `PI_MODEL` が利用不能でも候補が他にあれば `ready: true` と `defaultModelError` を返し、別モデルへは自動で切り替えない。`sandboxConfigured` は `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が揃っているか（未設定ならセッション作成が 503 になる）を示す。

```json
{
  "ok": true,
  "ready": true,
  "sandboxConfigured": true,
  "model": "deepseek/deepseek-v4-flash",
  "availableModels": ["deepseek/deepseek-v4-flash"],
  "modelOptions": [
    {
      "provider": "deepseek",
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "supportsThinking": true,
      "thinkingLevels": ["off", "low", "high", "max"]
    }
  ],
  "defaultThinkingLevel": "medium",
  "defaultModelError": "指定された既定モデルは利用できません: openai/ghost",
  "sessionStore": { "path": "/var/lib/pi-agent-gui/sessions", "ok": true, "dirty": 0 }
}
```

`modelOptions` は認証済みで利用可能なモデルのみ。`PI_MODELS` を指定したときは、その whitelist と利用可能モデルの積だけになる（`PI_MODEL` が whitelist 外なら `defaultModelError`、積が空なら `ready: false` と PI_MODELS を名指しした `error`）。能力情報（`supportsThinking` / `thinkingLevels`）は pi SDK の公開ヘルパー（`getSupportedThinkingLevels`）から得る。`defaultThinkingLevel` は `PI_MODEL` の末尾指定 → `PI_THINKING` → `medium` の優先順位で決まる。解決の詳細は [model-effort.md](model-effort.md)。

## ファイル一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files?path=<root 相対>` | 作業ディレクトリの一覧。`path` 省略時は root（`"."`） |

サンドボックスの `GET /v1/files` の応答を、そのまま DTO（`FileListing`）として返す。セッションに依存させない（`/api/sessions/:id/...` 配下に置かない）ため、セッションが無くても、APIキーが未設定で `/api/health` が `ready: false` でも開ける。

```json
{
  "path": "src",
  "entries": [
    { "name": "client", "type": "dir" },
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

## テキストプレビュー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/preview?path=<root 相対>` | テキストファイルの内容（UTF-8、256 KiB 以下） |

`{ "text": "内容" }` を返す（`Cache-Control: no-store`）。サンドボックスの `GET /v1/files/preview` に委譲し、root 内の通常ファイルのみ読み取る。この経路では HTML や Markdown も実行・レンダリングせずプレーンテキストとして返す（HTML の描画は `GET /api/files/html` を使う）。

- 400 / 404: バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外（400）、実在しない（404）。サンドボックス側の文言をそのまま返す
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定
- 502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）

ファイル画面で選択するとタブとして開き、同じファイルの再選択はタブを増やさず表示だけを切り替える。タブは最大 8 枚で、超えると最も古いタブを閉じる。本文は表示中のタブの分だけ取得し、タブごとに保持する（切替では取り直さない）。「再読み込み」は開いているタブを保ったまま本文を捨てて取り直す。表示位置は本文の幅で決まり、狭いときはツリーの下、広いときはツリーの右に出る。行番号とシンタックスハイライトはクライアントの表示だけで、転送はプレーンテキストのまま（[file-preview.md](file-preview.md)）。

## HTML プレビュー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/files/html?path=<root 相対>` | HTML を描画するための本文（iframe の src。UTF-8、256 KiB 以下） |

サンドボックスの `GET /v1/files/preview` の応答を `text/html` としてそのまま返す（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）。本文はテキストプレビューと同じ経路で、拡張子はサーバーでは判定しない（HTML として開くかの判断はクライアントの `isHtmlPath` が持つ）。

iframe の中身は応答ヘッダだけで隔離する（親の CSP を継承させないために別ルートにする）。

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'
```

- 400 / 404: バイナリ・UTF-8 として不正なバイト列・上限超過・ディレクトリ・root 外（400）、実在しない（404）。テキストプレビューと同じ分類
- 502: サンドボックスへ到達できない / 認証失敗 / 契約外の応答（BFF が zod で検証して弾く）
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定

エラーも iframe の中で読めるように HTML 文書で返し、サンドボックス由来の文言は HTML エスケープする。方式と残リスクは [file-preview.md](file-preview.md)。

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

## セッションへのファイルアップロード

`POST /api/sessions/:id/files?name=<ファイル名>` は選択時の即時アップロードで、既定のアップロード先はセッションの作業フォルダ配下の `uploads/`。JSON ではなく raw ストリームで受け、`bodyGuard`（`/api/*` の 64 KiB 上限と text 化）より前に登録する。仕様と上限は [api-sessions.md](api-sessions.md#post-apisessionsidfiles)、保存の規則は [session-files.md](session-files.md#添付ファイルチャットからのアップロード) を参照する。

## プロジェクト

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/projects` | プロジェクト一覧（作成順） |
| POST | `/api/projects` | プロジェクト作成（新規ディレクトリの作成 or 既存ディレクトリの登録） |
| DELETE | `/api/projects/:id` | 登録解除（配下セッションを破棄し、ディレクトリは残す） |

プロジェクトはワークスペース内のディレクトリで、サーバーのメモリ内にのみ存在する（再デプロイで消える）。`cwd` はワークスペース root（`health.cwd` = `PI_APP_CWD`）相対の正規化パスで、root 自身（`""` / `"."`）は登録できない（未所属セッションの作業場所）。セッションの作業ディレクトリは所属プロジェクトの `cwd` を root と結合して決まり、作成後に変えることはできない。実行時の隔離は行わない（`cwd` はツールのパス解決の起点のみ。詳細は [projects.md](projects.md)）。

```json
{
  "projects": [
    { "id": "…", "name": "pi-agent-gui", "cwd": "projects/pi-agent-gui", "createdAt": 1700000000000 }
  ]
}
```

### `POST /api/projects`

```json
// request
{ "cwd": "projects/pi-agent-gui", "name": "pi-agent-gui", "create": false }
// response (201)
{ "project": { "id": "…", "name": "pi-agent-gui", "cwd": "projects/pi-agent-gui", "createdAt": 1700000000000 } }
```

- `cwd` は root 相対。`a//b/` や `./a` は正規化する。絶対パス・`..` を含むパス・空文字・root 自身は 400。`cwd` 以外も含め body が契約外なら 400。
- `name` 省略時は `cwd` の basename。
- 同じ `cwd` の二重登録は 409（サンドボックスへは触らない）。
- `create: true` はサンドボックスで `mkdir -p` 相当を行う（親の存在は要求しない）。省略時は既存ディレクトリであることを確認する。新しい stat API は持たず、サンドボックスの `GET /v1/files` がディレクトリ以外で失敗する性質を使う。サンドボックス由来の 4xx（`Path not found` など）はステータス・文言ごとそのまま返る。
- 503: `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定。

### `DELETE /api/projects/:id`

`{ "ok": true }` を返す。配下の live セッションは停止（実行中は abort）し、購読中の SSE へは所属が外れた `resync` が届く（`session_deleted` は送らない）。セッションの会話ストアと作業フォルダ、ワークスペースのディレクトリ（ファイル・Git リポジトリを含む）には触らない。未知の id は 404。
