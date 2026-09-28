# 画像生成（generate_image ツール）

チャットから画像を生成し、セッションの作業フォルダへ保存する。生成そのものは BFF が provider（v1 は OpenRouter）へ要求し、保存だけをサンドボックスの upload API へ委譲する（BFF は作業領域に触らない）。provider の APIキーは 設定 → モデル の「画像生成」タブで登録し、アプリ DB の `image_settings` に**平文**で保存する。

- 画像専用のキー・モデルを `provider_credentials` とは別に管理する。プロバイダー登録済みキーは流用せず、画像タブで登録したキーだけを使う（別 provider のキーへ黙って切り替えない）
- キーが有効（`image_settings` に行がある）ときだけ、モデルへ `generate_image` を見せる。未設定ならツール一覧に現れない
- ツールは **BFF ローカル**（`server/src/image-tools.ts`）。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない
- 保存は `workspace.uploadFile({ dir, name })`。`dir` は root 相対で渡す（BFF がセッション cwd を前置する 1 段。`projects.ts` の cwd 解決とは混ぜない）
- 設定画面の操作は 設定 → モデル の「画像生成」タブ。API は [api.md](api.md#画像生成設定--モデルの画像生成タブ) を参照

## 保存先とパスの空間

| 空間 | 例 | 使う場所 |
| --- | --- | --- |
| cwd 相対 | `generated/cafe.png` | ツール引数 / 結果、`read`、Markdown 画像の src |
| root 相対 | `projects/u7agent/generated/cafe.png` | サンドボックス API（`dir`）、`GET /api/files`、raw URL |

- 既定の保存先はセッション cwd の `generated/<slug>.<ext>`。`<slug>` はプロンプトを `[a-z0-9-]` へ正規化した 40 文字まで（英数字が取れなければ `image-<ISO 日時>`）、`<ext>` は保存する mimeType から決める（png / jpeg / webp）
- `path` を明示したときは拡張子も含めてそのまま使う（mimeType で上書きしない）。親ディレクトリは upload が作る
- 同名のファイルがあっても上書きせず、サンドボックスが `-1` などの連番を付ける。ツール結果には**実際に保存された cwd 相対パス**を返す（root 相対は返さない。返すと `read` と Markdown 解決で二重に前置される）
- 拒否規則は write / edit と同じ思想で、`..` / 絶対パス / バックスラッシュ / 空の name（末尾 `/` を含む）を BFF が拒む。upload API は root 配下の任意ディレクトリへ書けるため、cwd 配下チェックは必ず BFF 側で行う
- 保存上限はサンドボックスの upload 既定（100 MiB）に従う

## 有効化（ゲート）

`image_settings` の行の有無だけがゲートで、`PiBff.imageGenerationEnabled` と `PiBff.setImageGeneration()` がその写し先になる。

- `bootstrap.ts` は `AppDb.open()` の後、`ModelSettingsService.applyStored()` と同じ順序で `ImageSettingsService.applyStored()` を呼ぶ。行があれば（キーをマスカーへ登録してから）有効化し、行が無ければ無効のまま起動する
- キー登録・削除の API は**同じミューテーションロックの内側**で `setImageGeneration()` を更新する。次のセッション作成から効き、再起動は要らない
- ツール一覧はセッション作成時に固定する（新しい会話と復元から効く）。有効化しても既存の live セッションには遡及しない
- `execute` は作成時のキーを握らず、毎回 `image_settings` を読み直す。未設定・削除後はキー無効エラーを返し、キーの変更・回転にも追随する
- pi ランタイム初期化に失敗したとき（`pi` が null）は `retainSecret` が no-op になり、キーを保護対象へ足せない。この状態のキー登録は model-settings と同じく 503 `not_stored` にする（DB へも書き込まない）

## 失敗の分類

`generateImages()` は失敗を throw せず `stopReason: "error"` と `errorMessage` に畳む。status も `onResponse` も取れない（非 2xx では SDK が reject する）ため、`server/src/images.ts` が次で分類する。

- `ImagesOptions.fetch` を自前で包み、非 2xx の status を記録する（最初の非 2xx を分類の根拠にする）
- 期限は自前の `AbortController` + タイマーだけに掛ける（`ImagesOptions.timeoutMs` は渡さない。SDK の期限が先に返ると status 未記録のまま原因不明に落ちるため）。既定は 180 秒
- ユーザー中断は `signal.aborted` で `timedOut` と区別する。signal はそのまま provider 呼び出しへ渡す
- `AssistantImages.output` に画像が 0 件のときは失敗として扱い、text だけを結果に載せない（モデルへ「生成できた」と誤解させない）

| 分類 | 条件 | 文言 |
| --- | --- | --- |
| `invalid_key` | 401 / 403 | 画像APIキーが無効です。設定を確認してください |
| `insufficient_credit` | 402 | 画像生成の残高が不足しています |
| `rate_limited` | 429 / 5xx | 画像生成が混雑しています（レート制限またはプロバイダー障害） |
| `timeout` | 自前タイマーの abort | 画像生成がタイムアウトしました |
| `aborted` | ユーザー中断 | 画像生成を中断しました |
| `unknown` | それ以外 | 画像生成に失敗しました（マスク済みの provider メッセージを 500 文字まで添える） |

分類はこの 1 箇所に閉じる。将来 OpenAI provider を足すときは `createImagesGenerator({ providers })` の差し替えで足し、status の写像だけを provider ごとに増やす。

## キーの扱い

- キーは GET 応答・ログ・health・エラー文言に出さない。`PUT /api/settings/images/key` は **DB へ書く前に** `retainSecret()` でマスカーへ登録する。起動時も `applyStored()` が保存行のキーを登録する
- 削除・上書き後もプロセス生存中は保護対象から外さない（`session.jsonl` の再投影で旧キーを出さないため）
- ツール定義（BFF ローカル）は `wrapToolDefinitionWithSecretMasker` で包み、execute が throw する文言もマスカーを通す。DB の例外文言は `AppDb` の `sanitizeError` 境界でマスクしてから health / 503 へ出す
- キーの長さは 8..2048 文字（`provider_credentials` と同じ）。カタログ外のモデルと `openrouter` 以外の provider は 400

残存リスクは model-settings と同様で、キーはアプリ DB に平文で残る。ログイン認証のない BFF を LAN / インターネットへ公開しない。

## ツールとプレビュー

- ツール引数は `prompt`（必須）と `path`（省略可、cwd 相対）。ツール説明と system prompt（`appendSystemPrompt` の画像生成行）に、生成物の場所と「本文には Markdown 画像で示す」ことを入れる
- 生成物の確認は `read`。SDK の `read` は画像を返せる
- チャットのプレビューは Markdown 画像の cwd 相対解決で行う。`![alt](generated/cafe.png)` を 1) `resolveFileRef(src, rootCwd, cwd)` → 2) `fileTreeFetchPath(cwd, resolved)` → 3) `fileRawUrl(rootRelative)` の 3 段で解決し、添付画像と同じ `ZoomableImage`（variant `markdown`）で表示する（[markdown.md](markdown.md#画像の-src-解決)）。解決できなければ従来どおり src をそのまま描く（外部 URL は CSP で読み込めない）

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/images` | `configured` / `provider` / `model` / `models`（カタログ）/ `runtimeAvailable`。キーは返さない |
| PUT | `/api/settings/images` | `{ provider, model }`。キーを保持したまま選択を更新（行が無ければ 400） |
| PUT | `/api/settings/images/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/images/key` | 行ごと削除（未設定へ戻す。冪等） |

- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映が無いため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`（直後に画面から変更できる）
- 詳細と例は [api.md](api.md#画像生成設定--モデルの画像生成タブ)

## テスト

実 API は呼ばず、ダミーキー + stub provider / fake サンドボックスで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/images.test.ts` | カタログ / 失敗分類（401・403・402・429・5xx・timeout・ユーザー中断・原因不明）/ 画像 0 件の失敗 / provider メッセージのマスク |
| `server/test/image-tools.test.ts` | ツールの組み立て（有効時だけ）/ path の拒否規則 / slug と拡張子 / root 相対への前置き / 同名衝突で実際の保存名を返す / execute が毎回設定を読む / throw のマスク / signal の伝播 |
| `server/test/image-settings.test.ts` | GET / PUT / DELETE の契約、マスカー登録の順序、既定行、行が無い / provider / カタログ外の 400、runtime 無しの 503、DB 失敗の 503、起動時の適用 |
| `server/test/image-settings-api.test.ts` | HTTP 契約と DB 例外のマスク、起動時の有効化、キーが応答・health・ログへ出ないこと |
| `server/test/app-db.test.ts` | v7 → v8 の加算移行と `image_settings` の CRUD、空文字行 = 未設定 |
| `client/test/markdownImage.test.ts` | Markdown 画像の 3 段解決 / 解決できない src / `components/markdown/` が `api.ts` を import しないこと |

## 非ゴール

- OpenAI provider の実装（差し替え点だけ残す）
- コスト表示、キー有効性のプレチェック、provider 切替 UI、プロバイダー登録済みキーの流用
- サイズ / 品質 / 出力形式の変更、参照画像による編集、複数枚生成、ツール結果への画像 content
