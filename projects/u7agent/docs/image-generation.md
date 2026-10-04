# 画像生成（generate_image ツール）

チャットから画像を生成し、セッションの作業フォルダへ保存する。生成そのものは BFF が provider（v1 は OpenRouter）の画像専用 API（`POST {baseUrl}/images`）へ要求し、保存だけをサンドボックスの upload API へ委譲する（BFF は作業領域に触らない）。provider の APIキーは 設定 → モデル の「画像生成」タブで登録し、アプリ DB の `image_settings` に**平文**で保存する。モデルの選択肢は OpenRouter の画像モデル API（`GET /api/v1/images/models`）を正とし、取得できないときは前回の成功（アプリ DB のキャッシュ）→ SDK 同梱の順に落ちる。保存名を決められない形式（svg など）しか返さないモデルは選択肢から外し、生成前にも止める（[保存できない形式のモデル](#保存できない形式のモデル)）。

- 画像専用のキー・モデルを `provider_credentials` とは別に管理する。プロバイダー登録済みキーは流用せず、画像タブで登録したキーだけを使う（別 provider のキーへ黙って切り替えない）
- キーが有効（`image_settings` に行がある）ときだけ、モデルへ `generate_image` を見せる。未設定ならツール一覧に現れない
- ツールは **BFF ローカル**（`server/src/image-tools.ts`）。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない
- 保存は `workspace.uploadFile({ dir, name })`。`dir` は root 相対で渡す（BFF がセッション cwd を前置する 1 段。`projects.ts` の cwd 解決とは混ぜない）
- 設定画面の操作は 設定 → モデル の「画像生成」タブ。API は [api.md](api.md#画像生成設定--モデルの画像生成タブ) を参照

## モデルカタログ

選択肢の正は OpenRouter の live 一覧（`GET https://openrouter.ai/api/v1/images/models`）。pi-ai 同梱のカタログは SDK のリリース時点のスナップショットで、live とずれる（追加されたモデルが出ない / `/images` に無い `openrouter/auto*` が混ざる）。実装は `server/src/image-catalog.ts`。

| 出どころ (`catalogSource`) | いつ | `fetchedAt` |
| --- | --- | --- |
| `live` | このプロセスで取得に成功した（メモリ保持） | 取得時刻 |
| `stored` | 今回の起動では取れず、前回の成功を DB キャッシュから読んだ | 前回の取得時刻 |
| `sdk` | キャッシュも無く、SDK 同梱のカタログを使っている（ルーター用メタモデルは除外） | `null` |

- 取得は **API キーを使わない**（一覧 API は認証を見ないので、認証ヘッダも付けない）。キーの有無・有効性とは独立で、**キーの死活チェックには使えない**（無効なキーでも 200 が返る）
- 取得契機は 起動時（`image_settings` に行があるとき）/ 手動の [再取得]。`GET /api/settings/images` はネットワークに触らず、メモリ上の現在値を返すだけ。キー保存にも紐づけない（設定の変更を外部 API の待ち時間へ巻き込まない）
- 期限は 10 秒（`IMAGE_CATALOG_TIMEOUT_MS`）+ リトライなし。失敗は timeout / 混雑（429・5xx）/ 不明の固定文言へ分類し、上流の応答本文はログにも UI にも出さない
- 取得成功時だけ DB（`image_catalog`）へ `id` と表示名、あれば出力形式の宣言（`outputFormats`）を残す。失敗しても一覧は前のままで、`catalogSource` / `fetchedAt` も変えない
- live は `supported_parameters.output_format`（`{ type: "enum", values: ["png", ...] }`）に出力形式を宣言する。**保存できる形式（png / jpeg / webp）を 1 つも宣言していないモデルは一覧から落とす**（今は `recraft/*-vector` の 6 件が `["svg"]` 単独）。判定は `server/src/images.ts` の `isUnsaveableOutputOnly()` 1 つで、保存側の `imageExtensionFor()` と同じ表を見る（[保存できない形式のモデル](#保存できない形式のモデル)）
- 宣言が無い（フィールドが無い / `values` が配列でない）ときは形式「不明」として扱い、一覧の絞り込みも生成前ガードも動かさない。SDK 同梱カタログと、この項目より前に書かれたキャッシュがこれにあたる
- 形式の宣言は一覧から落ちたモデルもメモリとキャッシュに残し、生成前ガードが引けるようにする（`ImageCatalog.outputFormatsOf()`）。宣言そのものは `models` の応答には載せない（選べるモデルの一覧と、サーバー内の判定を混ぜない）
- 起動時は先にキャッシュを読み、行があれば続けて live を試す。live が失敗しても「前回の一覧」から始められる
- SDK 同梱へ落ちるときは `openrouter/*`（= `openrouter/auto*`）を除く。画像専用 API に存在せず、選ぶと生成が 404 になる
- キャッシュは利用者データではなく派生データとして扱う。行が無い / 形が違う / JSON が壊れているときは「未取得」として読み、health の失敗にはしない（破損を DB 全体の失敗にしない。次の取得成功が行を上書きして直る）
- 生成は保存された id をそのまま `/images` へ送る。live カタログにしか無いモデルでも、SDK 同梱の一覧にあるかどうかでローカルには弾かない。SDK から借りるのは provider の `baseUrl` / ヘッダだけで、一覧にその id が無いときは同じ provider の先頭モデルをひな形にする（**provider 内で全モデルが同じ `baseUrl` / ヘッダを使う前提**。openrouter の 55 モデルは全件同一。provider 内でモデルごとに送信先が異なる provider を足すときは、この流用を置き換えること。`server/src/images.ts`）

### 画面表示

モデル欄に由来と最終取得時刻を出す。`live` 以外は警告色で、前回の一覧 / SDK 同梱のどちらを見ているかを明示する（黙って古い一覧を見せない）。表示はプロバイダータブと同じ `MetaChip` のチップで、`live` は muted、それ以外は warn にする。文が長いためこのチップだけは折り返しを許し、[再取得] を隣に置く。段落のセマンティクス（暗黙の `paragraph` ロール）を残すために `<p>` で包み、`wrap` のチップは `inline-block max-w-full` で 1 つの枠のまま中で折り返す（inline のままだと行ごとに枠線が分断される）。

- `live`: 「モデル一覧は OpenRouter から取得しました（最終取得: 3時間前）」
- `stored`: 「OpenRouter から取得できなかったため、前回の一覧を表示しています（最終取得: …）」
- `sdk`: 「OpenRouter から取得できていないため、SDK の組み込み一覧を表示しています」
- [再取得] は `POST /api/settings/images/catalog/refresh`。**常に 200** で現在の一覧を返し、今回の取得に失敗したときだけ `catalogError`（固定文言）を載せる。UI は既存の注記で「取得できませんでした。表示中の一覧は変わりません。」と出す

## 保存できない形式のモデル

SVG を返す vectorization モデル（`recraft/*-vector` など）は**製品として対応しない**。SVG は `RAW_IMAGE_CONTENT_TYPES` / client の `IMAGE_EXTENSIONS` / `fileKind.ts` / `agents.ts` の 4 箇所で意図的に締め出しており（同一オリジンでスクリプトが動くため）、保存・プレビュー・raw 配信は開けない。代わりに選択肢から外し、「保存名を決める段で初めて失敗して課金だけが残る」経路を閉じる。

- 判定規則: カタログが形式を宣言していて（`outputFormats` が空でなく）、その中に png / jpeg / webp が 1 つも無いときだけ「保存できない」と確定する。宣言なし・カタログに無い id は止めない（`isUnsaveableOutputOnly()`）
- 一覧: 上の判定に当たるモデルは `GET /api/settings/images` の `models` に出ない。UI から選べず、`PUT /api/settings/images` もカタログ外として 400 にする
- 生成前ガード: 保存済みの選択がそれに当たる場合（この変更より前に保存された行・古いキャッシュ由来）は、`ImageGenerationConfig.readOutputFormats` で宣言を引き、**provider の `/images` を叩く前に**ツールが throw する。課金は起きない
- 保存段での失敗（`imageExtensionFor()` の throw）は、ハイブリッドなモデルが svg を返したときなど**生成が完了した後**にだけ起きる。文言でクレジット消費済みであることを明示する

| 止めた場所 | 文言 |
| --- | --- |
| 生成前ガード | この画像モデルは png / jpeg / webp を返さないため、生成は行っていません（クレジットは消費していません）。設定 → モデル で別の画像モデルを選んでください |
| 保存段（`imageExtensionFor`） | 対応していない画像形式です: `<mimeType>`（生成は完了しており、クレジットは消費されています）。設定 → モデル で別の画像モデルを選んでください |

`output_format` の明示送信はしない（モデルごとに対応差があり、対応表が要る。今のカタログに svg とラスタを両方宣言するモデルは無いため効果も無い）。実行分類（`RunErrorCode` / `error-classify.ts`）にも専用コードは足さず、`unknown` のままにする。

### 残る穴

- live の取得が一度も成功せず SDK 同梱カタログへ落ちているときは形式宣言が読めず、絞り込みも生成前ガードも効かない（SDK の一覧に形式情報が無い）。[再取得] か次の起動で live を取れれば解消する
- この変更より前に書かれた `image_catalog` のキャッシュも宣言を持たないため、一時的に vector モデルが出得る（次の live 取得成功が行を上書きして解消する）
- svg とラスタの両方を宣言するモデルは一覧に残るため、svg が返れば保存段で失敗して課金だけが残る。今のカタログには該当が無く、`output_format` を送らない方針とも合わせて既知の穴に留める

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

### 会話履歴を保つ生成手順

会話の画像はファイルへのライブ参照で、生成時点の画像バイトを保存するスナップショットではない。過去の表示を保つため、生成した一意ファイルは上書き・移動せずに残す。

- 本文の Markdown 画像には、**必ずツール結果が返した実際の保存パス**を使う。要求した `path` と結果が異なる場合も、結果のパスを正とする
- 既存の生成ファイルを上書きしない。`generate_image` は同名衝突時に新しい生成物へ `-1` などを付け、既存ファイルを保つ
- 固定名の「最新コピー」が必要なら、一意ファイルを残したまま `cp` で別の場所へ置く。会話が参照するファイルを `mv` で動かさない。本文には最新コピーではなく、一意ファイルのパスを使う

例えば結果が `generated/cafe-1.png` なら、本文は `![cafe](generated/cafe-1.png)` とし、固定名が必要な場合だけ次を実行する。

```bash
mkdir -p assets
cp generated/cafe-1.png assets/cafe-latest.png
```

`generated/cafe-1.png` はそのまま残す。最新コピー用の追加ツール引数は設けず、`path` の説明と system prompt のガイドラインでこの運用を指示する。参照元を別ツールで上書き・削除した場合の履歴保護は保証しない。

## 有効化（ゲート）

`image_settings` の行の有無だけがゲートで、`PiBff.imageGenerationEnabled` と `PiBff.setImageGeneration()` がその写し先になる。

- `bootstrap.ts` は `AppDb.open()` の後、`ModelSettingsService.applyStored()` と同じ順序で `ImageSettingsService.applyStored()` を呼ぶ。行があれば（キーをマスカーへ登録してから）有効化し、行が無ければ無効のまま起動する
- キー登録・削除の API は**同じミューテーションロックの内側**で `setImageGeneration()` を更新する。次のセッション作成から効き、再起動は要らない
- ツール一覧はセッション作成時に固定する（新しい会話と復元から効く）。有効化しても既存の live セッションには遡及しない
- `execute` は作成時のキーを握らず、毎回 `image_settings` を読み直す。未設定・削除後はキー無効エラーを返し、キーの変更・回転にも追随する
- pi ランタイム初期化に失敗したとき（`pi` が null）は `retainSecret` が no-op になり、キーを保護対象へ足せない。この状態のキー登録は model-settings と同じく 503 `not_stored` にする（DB へも書き込まない）

## 失敗の分類

SDK(pi-ai 0.99.1) の `openrouter-images` は `chat/completions` へ投げるが、画像生成専用モデルはそちらでは 404（`Use the /api/v1/images endpoint instead.`）になる。そのため `server/src/images.ts` は SDK の `generateImages()` を通さず `POST {baseUrl}/images` を自分で叩き、status と本文も自分で読んで次で分類する。SDK は provider の `baseUrl` / ヘッダのひな形にだけ使い、送信する model id は要求のものをそのまま使う（一覧の正は live なので、SDK の一覧に無い id でもローカルでは弾かない。[モデルカタログ](#モデルカタログ)）。

- 非 2xx の status を分類の根拠にする。理由は本文の `error.message` を優先し、形が違うときだけ生テキストへ落とす（生テキストは非 2xx のみ）
- 期限は自前の `AbortController` + タイマーだけに掛ける。既定は 180 秒
- ユーザー中断は `signal.aborted` で `timedOut` と区別する。signal はそのまま fetch へ渡す
- 画像は `data[0].b64_json`。`media_type` は data の各件 → 応答全体の `media_type` → `image/png` の順に落とす
- 2xx でも画像が 0 件なら失敗として扱う（モデルへ「生成できた」と誤解させない）。理由は生の応答本文にはフォールバックせず、`error.message` があればマスクして添える

| 分類 | 条件 | 文言 |
| --- | --- | --- |
| `invalid_key` | 401 / 403 | 画像APIキーが無効です。設定を確認してください |
| `insufficient_credit` | 402 | 画像生成の残高が不足しています |
| `rate_limited` | 429 / 5xx | 画像生成が混雑しています（レート制限またはプロバイダー障害） |
| `timeout` | 自前タイマーの abort | 画像生成がタイムアウトしました |
| `aborted` | ユーザー中断 | 画像生成を中断しました |
| `unknown` | それ以外 | 画像生成に失敗しました（マスク済みの provider メッセージを 500 文字まで添える） |

要求の組み立てと分類はこの 1 箇所に閉じる。将来 OpenAI provider を足すときは `createImagesGenerator({ models })` の差し替えでカタログを足し、エンドポイント / 応答形と status の写像だけを provider ごとに増やす。

## キーの扱い

- キーは GET 応答・ログ・health・エラー文言に出さない。`PUT /api/settings/images/key` は **DB へ書く前に** `retainSecret()` でマスカーへ登録する。起動時も `applyStored()` が保存行のキーを登録する
- 削除・上書き後もプロセス生存中は保護対象から外さない（`session.jsonl` の再投影で旧キーを出さないため）
- ツール定義（BFF ローカル）は `wrapToolDefinitionWithSecretMasker` で包み、execute が throw する文言もマスカーを通す。DB の例外文言は `AppDb` の `sanitizeError` 境界でマスクしてから health / 503 へ出す
- キーの長さは 8..2048 文字（`provider_credentials` と同じ）。カタログ外のモデルと `openrouter` 以外の provider は 400

残存リスクは model-settings と同様で、キーはアプリ DB に平文で残る。ログイン認証のない BFF を LAN / インターネットへ公開しない。

## 設定画面（画像生成タブ）

設定 → モデル の 3 つ目のタブ（`/settings/models/images`）。表示の正は `client/src/lib/imageSettings.ts` の純関数、取得と操作は `client/src/hooks/useImageSettings.ts`、描画は `client/src/components/model-settings/ImageSettingsTab.tsx` に閉じる。

- 未設定ではキー入力だけを出す。`PUT /api/settings/images` は行が無いと 400 のため、モデル選択と削除はキー保存（`PUT /api/settings/images/key`）に成功してから現れる
- タブの上部に provider の見出し（ロゴ + 表示名 + provider id + 登録状態バッジ + `カタログ <n>`）を出す。ロゴは `client/src/components/ProviderIcon.tsx` の `providerIconKey()` で引き、表示名と id は `imageProviderId()` / `imageProviderLabel()` が決める。v1 は openrouter だけなので未設定（`null`）でも OpenRouter を出し、provider が増えれば `settings.provider` に追随して同じ見出しのロゴが切り替わる（対応表に無い provider は頭文字のタイルへ落ちる）。件数と登録状態のチップはプロバイダータブと同じ `MetaChip` を使う
- 登録状態バッジ（設定済み / 未設定）は上部の見出しに出す（プロバイダータブと同じ見た目。`imageKeyStatusBadge()`）。キー欄の補足には provider 名（OpenRouter）を添え、モデル欄に出る `OpenAI: …` と混同させない
- キーは `type="password"` / `autoComplete="off"` で、保存値を再表示しない（常に空から入力する）。[上書き保存] は成功したときだけ入力を消し、[削除] は共通の確認ダイアログ（`deleteImageKeyConfirmRequest()`。対象の provider は clamp した行に出す）の後に行ごと消して未設定へ戻す
- モデルは native `<select>`（`SelectField`）でカタログから 1 件選ぶ。保存済みのモデルがカタログに無いときは「（カタログ外）」として現在の id を先頭に足す（何が保存されているかを見失わせない）。サイズ / 品質 / 出力形式の UI は持たず、本文にはその理由（provider の既定を使う）だけを書く。provider 名は見出しにあるため繰り返さない
- 注意書きは詳細の上部に常時出す（平文保存・再表示しない・ログイン無しで公開しない・有効性は保存時に見ない・キーは 8 文字以上・プロバイダー登録キーとは別管理）。下部に「保存したキーは新しい会話から使える（ツール一覧はセッション作成時に固定）」と、生成物の保存先（作業フォルダの `generated/`）を注記する
- `runtimeAvailable: false` のときはキー登録・上書き・削除を disable し、プロバイダータブと同じ理由（サーバーの起動ログ）を出す。モデルの変更は SDK に触れないため残す。変更系の 503 `state: "not_stored"` は「変更は保存されていません。」を付けて画面の注記へ出す
- 画面の [再読み込み] はモデル設定と画像設定の両方を取り直す。キーの登録・削除は再起動を待たず、次に作るセッションから効く

## ツールとプレビュー

- ツール引数は `prompt`（必須）と `path`（省略可、cwd 相対）。ツール説明と system prompt（`appendSystemPrompt` の画像生成行）に、生成物の場所と「本文には Markdown 画像で示す」ことを入れる
- ツール結果本文には保存パスと一緒に使用モデル（実行時に読んだ `model`）を行で残す。会話履歴は `session.jsonl` の `toolResult` の生 content を正とするため、別途 DB へは保存せず、ライブ・復元後の両方でツール履歴の出力から何で生成したかを追える。設定を変更した後の実行にはその時点のモデルが入る
- モデル行は結果本文の先頭に置く。投影（`toolResultSummary`）は先頭 900 文字（`SUMMARY_TEXT_MAX`）で切るため、長い `path` を指定しても表示からモデルが欠けないようにする
- 生成物の確認は `read`。SDK の `read` は画像を返せる
- チャットのプレビューは Markdown 画像の cwd 相対解決で行う。`![alt](generated/cafe.png)` を 1) `resolveFileRef(src, rootCwd, cwd)` → 2) `fileTreeFetchPath(cwd, resolved)` → 3) `fileRawUrl(rootRelative, imageVersion)` の 3 段で解決し、添付画像と同じ `ZoomableImage`（variant `markdown`）で表示する（[markdown.md](markdown.md#画像の-src-解決)）。解決できなければ従来どおり src をそのまま描く（外部 URL は CSP で読み込めない）
- raw URL の `v` は[document 内の共有採番](api.md#画像配信raw)で得る版。`ChatState.runEndSeq` の変化を合図に URL を変え、同一パスが差し替わっていてもブラウザの in-document 画像キャッシュを使わずに取り直す。これは現在のファイルへの追随であり、履歴を不変にするのは上記の[生成手順](#会話履歴を保つ生成手順)。添付画像はアップロードごとの一意名で不変なので版を付けない

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/images` | `configured` / `provider` / `model` / `models`（カタログ）/ `catalogSource` / `fetchedAt` / `runtimeAvailable`。キーは返さない |
| PUT | `/api/settings/images` | `{ provider, model }`。キーを保持したまま選択を更新（行が無ければ 400） |
| PUT | `/api/settings/images/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/images/key` | 行ごと削除（未設定へ戻す。冪等） |
| POST | `/api/settings/images/catalog/refresh` | live カタログの再取得。常に 200 で `models` / `catalogSource` / `fetchedAt` / `catalogError` を返す（失敗時も一覧は返す） |

- `catalogSource` は `live` / `stored` / `sdk` で、`models` の出どころを表す（[モデルカタログ](#モデルカタログ)）。`live` 以外は取得に失敗している状態で、`fetchedAt` は最後に live を取得できた時刻（`sdk` のときは `null`）

- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映が無いため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`（直後に画面から変更できる）
- 詳細と例は [api.md](api.md#画像生成設定--モデルの画像生成タブ)

## テスト

実 API は呼ばず、ダミーキー + stub provider / fake サンドボックスで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/images.test.ts` | カタログ / `chat/completions` へ戻らないこと（`/images` の送信先・ヘッダ・本文）/ `media_type` の落とし方 / 失敗分類（401・403・402・429・5xx・timeout・ユーザー中断・原因不明）/ 画像 0 件の失敗（2xx の生本文と `error.message`）/ provider メッセージのマスク / SDK 同梱カタログから `openrouter/*` を落とすこと / SDK の一覧に無い id（live のみのモデル）も provider の URL で送ること |
| `server/test/image-catalog.test.ts` | live の採用とキャッシュ保存（認証ヘッダを付けない / id と表示名と形式の宣言）/ 出力形式の取り込みと一覧の絞り込み（不明・形違いは落とさない）/ 宣言がキャッシュから読めること / 一覧から落ちた id の `outputFormatsOf` / 重複 id と表示名の欠落 / 失敗分類（429・5xx・契約外・空・timeout）と一覧の保持 / キャッシュの読込と live 失敗時の維持 / キャッシュの読取・保存失敗 |
| `server/test/image-tools.test.ts` | ツールの組み立て（有効時だけ）/ path の拒否規則 / slug と拡張子 / 結果パスの参照・一意ファイルの保持・最新コピーのガイドライン / 生成前ガード（保存できない形式だけを宣言したモデルで provider を叩かない・宣言なしと不明は止めない）/ 保存段の失敗文言（クレジット消費済み）/ root 相対への前置き / 同名衝突で実際の保存名と使用モデルを返す / 長い path でも投影の切詰めにモデルが残る / execute が毎回設定を読む / throw のマスク / signal の伝播 |
| `server/test/image-settings.test.ts` | GET / PUT / DELETE の契約、マスカー登録の順序、既定行、行が無い / provider / カタログ外の 400、runtime 無しの 503、DB 失敗の 503、起動時の適用（キャッシュ読込と、行があるときだけの live 取得）/ キー保存が取得を待たないこと / 再取得の失敗文言 / 注入する config の形式宣言 |
| `server/test/image-settings-api.test.ts` | HTTP 契約と DB 例外のマスク、起動時の有効化、キーが応答・health・ログへ出ないこと、カタログの出どころ / 再取得の 200 と `catalogError` / `models` の形（宣言を載せない） |
| `server/test/app-db.test.ts` | v7 → v8 / v8 → v9 の加算移行、`image_settings` の CRUD、空文字行 = 未設定、`image_catalog` の upsert と壊れた行（health を落とさない）、形式宣言の往復と形違いの読み方 |
| `client/test/markdownImage.test.ts` | Markdown 画像の 3 段解決 / version が変わったときだけ解決 URL が変わること / App の `runEndSeq` 配線 / 解決できない src / `components/markdown/` が `api.ts` を import しないこと |
| `client/test/imageRefresh.test.ts` | 実フックの再描画安定性・更新時の URL 非衝突 / 実 Markdown と FileBrowser の再 mount が過去の URL を再利用しないこと（SSR） |
| `client/test/imageSettings.test.ts` / `client/test/imageSettingsTab.test.ts` | 選択肢（カタログ順・同名への id 添え・カタログ外の現在値）/ 現在値と PUT の本文 / 保存成功時だけキー入力を消す / キーの登録状態バッジと provider の id・表示名 / 見出しの provider（ロゴ・未設定でも OpenRouter・対応表に無い provider は頭文字）と `カタログ <n>` のチップ / 一覧の出どころのチップと最終取得 / 再取得の注記 / タブの初期描画（未設定はキーのみ・設定済みは削除とモデル選択・キーを再表示しない・runtime 不可の disable・[再取得] の出し分け） |

## 非ゴール

- OpenAI provider の実装（差し替え点だけ残す）
- キーの有効性のチェック（live カタログの取得は API キーを見ないため兼用できない。やるなら別 API）
- TTL / バックグラウンドでのカタログ自動再取得（契機は起動と手動 [再取得] だけ）
- コスト表示、provider 切替 UI、プロバイダー登録済みキーの流用
- サイズ / 品質 / 出力形式の変更、参照画像による編集、複数枚生成、ツール結果への画像 content（svg-only の除外と生成前ガードは [保存できない形式のモデル](#保存できない形式のモデル)）
- SVG（vectorization）の保存・プレビュー・raw 配信。svg-only モデルを選択肢から外し、保存形式と同じく png / jpeg / webp だけを通す（[保存できない形式のモデル](#保存できない形式のモデル)）
