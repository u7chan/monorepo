# 画像生成（generate_image ツール）

チャットから画像を生成し、セッションの作業フォルダへ保存する。生成そのものは BFF が provider（v1 は OpenRouter）の画像専用 API（`POST {baseUrl}/images`）へ要求し、保存だけをサンドボックスの upload API へ委譲する（BFF は作業領域に触らない）。既存の画像を渡しての編集（image-to-image）は同じ `generate_image` の任意引数 `input_images` で行う（[参照画像による編集](#参照画像による編集)）。provider の APIキーは 設定 → コンテンツ生成（`/settings/content`）で登録し、アプリ DB の `content_settings` に**暗号化して**保存する（AEAD。AAD は `u7agent-app-secret:content_settings:apiKey`。[secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）。モデルの選択肢は OpenRouter の画像モデル API（`GET /api/v1/images/models`）を正とし、取得できないときは前回の成功（アプリ DB のキャッシュ）→ SDK 同梱の順に落ちる。保存名を決められない形式（svg など）しか返さないモデルは選択肢から外し、生成前にも止める（[保存できない形式のモデル](#保存できない形式のモデル)）。

- コンテンツ生成の共有キーと画像モデルを `provider_credentials` とは別に管理する。キーはTTS・[BGM](bgm-generation.md) と共有するが、会話プロバイダー登録済みキーは流用しない（別 provider のキーへ黙って切り替えない）。
- コンテンツ生成のゲートとエージェントの `toolNames` の積が有効なときだけ、モデルへ `generate_image` を見せる。未設定ならツール一覧に現れない。
- ツールは **BFF ローカル**（`server/src/image-tools.ts`）。サンドボックスのリモート定義ではなく、`createRemoteToolDefinitions` / `REMOTE_TOOL_NAMES` の外にあり、`PI_AGENT_TOOLS` の影響を受けない。エージェント定義の `toolNames` では外せる（[api-catalog.md](api-catalog.md#ツール許可リスト)）
- 保存は `workspace.uploadFile({ dir, name })`。`dir` は root 相対で渡す（BFF がセッション cwd を前置する 1 段。`projects.ts` の cwd 解決とは混ぜない）
- 設定画面は 設定 → コンテンツ生成（`/settings/content`）で操作する。API は [api.md](api.md#コンテンツ生成) を参照

## モデルカタログ

選択肢の正は OpenRouter の live 一覧（`GET https://openrouter.ai/api/v1/images/models`）。pi-ai 同梱のカタログは SDK のリリース時点のスナップショットで、live とずれる（追加されたモデルが出ない / `/images` に無い `openrouter/auto*` が混ざる）。実装は `server/src/image-catalog.ts`。

| 出どころ (`catalogSource`) | いつ | `fetchedAt` |
| --- | --- | --- |
| `live` | このプロセスで取得に成功した（メモリ保持） | 取得時刻 |
| `stored` | 今回の起動では取れず、前回の成功を DB キャッシュから読んだ | 前回の取得時刻 |
| `sdk` | キャッシュも無く、SDK 同梱のカタログを使っている（ルーター用メタモデルは除外） | `null` |

- 取得は **API キーを使わない**（一覧 API は認証を見ないので、認証ヘッダも付けない）。キーの有無・有効性とは独立で、**キーの死活チェックには使えない**（無効なキーでも 200 が返る）
- 取得契機は 起動時（`content_settings` に行があるとき）/ 手動の [カタログ更新]。`GET /api/settings/content` はネットワークに触らず、メモリ上の現在値を返すだけ。キー保存にも紐づけない（設定の変更を外部 API の待ち時間へ巻き込まない）
- 期限は 10 秒（`IMAGE_CATALOG_TIMEOUT_MS`）+ リトライなし。失敗は timeout / 混雑（429・5xx）/ 不明の固定文言へ分類し、上流の応答本文はログにも UI にも出さない
- 取得成功時だけ DB（`image_catalog`）へ `id` と表示名、あれば出力形式の宣言（`outputFormats`）と画像入力の宣言（`input`）を残す。失敗しても一覧は前のままで、`catalogSource` / `fetchedAt` も変えない
- 画像入力の宣言は `architecture.input_modalities` と `supported_parameters.input_references`、`endpoints` から読む（[参照画像による編集](#参照画像による編集)）。宣言が無い / 形が違うモデルは「不明」として残し、旧キャッシュも「不明」として読む（新規生成は巻き添えにしない）
- live は `supported_parameters.output_format`（`{ type: "enum", values: ["png", ...] }`）に出力形式を宣言する。**保存できる形式（png / jpeg / webp）を 1 つも宣言していないモデルは一覧から落とす**（`recraft/*-vector` が `["svg"]` 単独でこれに当たる）。判定は `server/src/images.ts` の `isUnsaveableOutputOnly()` 1 つで、保存側の `imageExtensionFor()` と同じ表を見る（[保存できない形式のモデル](#保存できない形式のモデル)）
- 宣言が無い（フィールドが無い / `values` が配列でない）ときは形式「不明」として扱い、一覧の絞り込みも生成前ガードも動かさない。SDK 同梱カタログと、この項目より前に書かれたキャッシュがこれにあたる
- 形式の宣言は一覧から落ちたモデルもメモリとキャッシュに残し、生成前ガードが引けるようにする（`ImageCatalog.outputFormatsOf()`）。宣言そのものは `models` の応答には載せない（選べるモデルの一覧と、サーバー内の判定を混ぜない）
- 起動時は先にキャッシュを読み、行があれば続けて live を試す。live が失敗しても「前回の一覧」から始められる
- SDK 同梱へ落ちるときは `openrouter/*`（= `openrouter/auto*`）を除く。画像専用 API に存在せず、選ぶと生成が 404 になる
- キャッシュは利用者データではなく派生データとして扱う。行が無い / 形が違う / JSON が壊れているときは「未取得」として読み、health の失敗にはしない（破損を DB 全体の失敗にしない。次の取得成功が行を上書きして直る）
- 生成は保存された id をそのまま `/images` へ送る。live カタログにしか無いモデルでも、SDK 同梱の一覧にあるかどうかでローカルには弾かない。SDK から借りるのは provider の `baseUrl` / ヘッダだけで、一覧にその id が無いときは同じ provider の先頭モデルをひな形にする（**provider 内で全モデルが同じ `baseUrl` / ヘッダを使う前提**。この前提が今も成り立つかは `server/test/images.test.ts` が SDK 同梱カタログで検査する。provider 内でモデルごとに送信先が異なる provider を足すときは、この流用を置き換えること。`server/src/images.ts`）

### 画面表示

モデル欄に由来と最終取得時刻を出す。`live` 以外は警告色で、前回の一覧 / SDK 同梱のどちらを見ているかを明示する（黙って古い一覧を見せない）。表示はプロバイダータブと同じ `MetaChip` のチップで、`live` は muted、それ以外は warn にする。文が長いためこのチップだけは折り返しを許し、[カタログ更新] を隣に置く。段落のセマンティクス（暗黙の `paragraph` ロール）を残すために `<p>` で包み、`wrap` のチップは `inline-block max-w-full` で 1 つの枠のまま中で折り返す（inline のままだと行ごとに枠線が分断される）。

- `live`: 「モデル一覧は OpenRouter から取得しました（最終取得: 3時間前）」
- `stored`: 「OpenRouter から取得できなかったため、前回の一覧を表示しています（最終取得: …）」
- `sdk`: 「OpenRouter から取得できていないため、SDK の組み込み一覧を表示しています」
- [カタログ更新] は `POST /api/settings/content/image/catalog/refresh`。**常に 200** で現在の一覧を返し、今回の取得に失敗したときだけ `catalogError`（固定文言）を載せる。UI は既存の注記で「取得できませんでした。表示中の一覧は変わりません。」と出す

## 保存できない形式のモデル

SVG を返す vectorization モデル（`recraft/*-vector` など）は**製品として対応しない**。SVG は `RAW_IMAGE_CONTENT_TYPES` / client の `IMAGE_EXTENSIONS` / `fileKind.ts` / `agents.ts` の 4 箇所で意図的に締め出しており（同一オリジンでスクリプトが動くため）、保存・プレビュー・raw 配信は開けない。代わりに選択肢から外し、「保存名を決める段で初めて失敗して課金だけが残る」経路を閉じる。

- 判定規則: カタログが形式を宣言していて（`outputFormats` が空でなく）、その中に png / jpeg / webp が 1 つも無いときだけ「保存できない」と確定する。宣言なし・カタログに無い id は止めない（`isUnsaveableOutputOnly()`）
- 一覧: 上の判定に当たるモデルは `GET /api/settings/content` の `image.models` に出ない。UI から選べず、`PUT /api/settings/content/image` もカタログ外として 400 にする
- 生成前ガード: 保存済みの選択がそれに当たる場合（この変更より前に保存された行・古いキャッシュ由来）は、`ContentGenerationConfig.readOutputFormats` で宣言を引き、**provider の `/images` を叩く前に**ツールが throw する。課金は起きない
- 保存段での失敗（`imageExtensionFor()` の throw）は、ハイブリッドなモデルが svg を返したときなど**生成が完了した後**にだけ起きる。文言でクレジット消費済みであることを明示する

| 止めた場所 | 文言 |
| --- | --- |
| 生成前ガード | この画像モデルは png / jpeg / webp を返さないため、生成は行っていません（クレジットは消費していません）。設定 → コンテンツ生成 で別の画像モデルを選んでください |
| 保存段（`imageExtensionFor`） | 対応していない画像形式です: `<mimeType>`（生成は完了しており、クレジットは消費されています）。設定 → コンテンツ生成 で別の画像モデルを選んでください |

`output_format` の明示送信はしない（モデルごとに対応差があり、対応表が要る。今のカタログに svg とラスタを両方宣言するモデルは無いため効果も無い）。実行分類（`RunErrorCode` / `error-classify.ts`）にも専用コードは足さず、`unknown` のままにする。

### 残る穴

- live の取得が一度も成功せず SDK 同梱カタログへ落ちているときは形式宣言が読めず、絞り込みも生成前ガードも効かない（SDK の一覧に形式情報が無い）。[カタログ更新] か次の起動で live を取れれば解消する
- この変更より前に書かれた `image_catalog` のキャッシュも宣言を持たないため、一時的に vector モデルが出得る（次の live 取得成功が行を上書きして解消する）
- svg とラスタの両方を宣言するモデルは一覧に残るため、svg が返れば保存段で失敗して課金だけが残る。今のカタログには該当が無く、`output_format` を送らない方針とも合わせて既知の穴に留める

## 参照画像による編集

`generate_image` の任意引数 `input_images` で元画像を渡すと、BFF がサンドボックスから画像を取得し、検証して base64 data URL にし、`/images` の `input_references` として送る。保存は既存の `workspace.uploadFile()` で**別ファイル**として行い、元画像は上書き・移動しない。

```ts
{ prompt: string; path?: string; input_images?: string[] } // MVP は 1 枚だけ
```

- `input_images` を省略したときは従来どおりの新規生成で、送信 JSON に `input_references` を付けない（既存呼び出しの送信 JSON・保存・プレビューは不変）
- 空配列・空パス・2 枚以上・許可範囲外・形式違い・上限超過は、**provider を呼ぶ前に**拒む（課金は発生しない）
- 入力に指定できるのは、現在のセッション cwd 相対のパス（例: `generated/portrait.png`）と、`<attached_files>` に載る絶対パス（この会話の添付置き場）だけ。許可範囲は BFF が決め、サンドボックスは実パスが範囲内のときだけ返す。範囲はリクエストの `scope` として渡し、モデル引数からは足せない
- 許可範囲はセッション cwd と `sessionUploadsRel(id, spaceId)` の 2 つ（追加スペースでは保存先も変わる）。モデルへは作成 / 復元時に注入し、ツール実行のたびに読み直さない
- 形式は拡張子ではなく**実バイト**で判定し、PNG / JPEG / WebP だけを通す（自動リサイズ・変換はしない）。既存の生成ツールは明示 `path` の拡張子を実形式に合わせないため、`.jpg` に PNG バイトが入っていても受け付ける。無拡張子・`.bin` も実体が画像なら通る（ブラウザ向け raw 配信の拡張子 allowlist は広げない）
- 上限は 1 枚 10 MiB・40 メガピクセル（`server/src/image-format.ts`）。バイト数は Content-Length と実受信バイト数の両方で見る
- ヘッダ検証までで、深い破損は provider の入力エラーとして扱う（デコーダーは足さない）
- 元画像が読めないとき・形式が違うとき・能力が不明なときに、参照なしの新規生成や別モデルへの切替へはフォールバックしない

### 課金前の能力判定

参照画像を使う編集だけ、`/images` の前に次を確かめる。どれかで止まったら課金は発生せず、理由を返す。

1. モデル一覧の `architecture.input_modalities` に `image` が含まれる
2. モデル一覧の `supported_parameters.input_references` が 1 枚を許容する（range なら `min <= 1 <= max`）
3. `endpoints` が指す URL（無ければ `GET /api/v1/images/models/<id>/endpoints`）を編集実行時に取得し、**すべての** endpoint が `supported_parameters.input_references` で 1 枚を許容する

- 状態は「対応 / 非対応 / 不明」を区別する。宣言の不在・形違い・旧キャッシュは「不明」で、編集だけを止め、新規生成は止めない
- endpoint の取得は編集実行時だけ（起動時や `GET /api/settings/content` では通信しない）。認証ヘッダを付けず、期限は `IMAGE_CATALOG_TIMEOUT_MS` と同じ。成功だけをプロセス内メモリに残し、失敗はキャッシュせず次の実行で引き直す
- endpoint 応答の形は、live で観測したとおり `{ id, endpoints: [...] }` を読む（各要素の `supported_parameters.input_references` が参照枚数の宣言）。トップレベルの `data[]` は live の応答には無いため依存しない。`data[]` だけを返す旧い形は後方互換として読み、`endpoints` が配列でなく `data` も無い（または空の）応答は契約外として「不明」に落とす
- endpoint 応答が `architecture` を持たないことは契約外にしない（モデル一覧側で確認する）。`input_references` の宣言が無い / 形が違う endpoint は「不明」として止める
- モデル名の固定対応表は持たない。`provider.only` によるルートの pin も行わない（対応 / 非対応が混在するモデルは編集対象外として案内する）
- 非対応 / 不明のときは別モデル・別キーへ自動で切り替えない

止めた理由（モデル宣言が非対応 / 不明、endpoint が 1 枚を受け付けない、endpoint の取得失敗・契約外）ごとの公開文言は `server/src/image-catalog.ts` の定数が正。どの文言も「編集は行っておらずクレジットは消費していない」ことを示し、同じ実行で参照を外した再生成や別モデルへの切替は行わない。テストは `server/test/image-catalog.test.ts` が固定する。

### 結果・ログの扱い

- ツール結果の先頭 2 行（モデル行・保存パス行）は編集でも変えない（クライアントの `generationInfo.ts` が読む接頭辞）。編集元はその後に `編集元: <cwd 相対>` として足す
- 取得した画像の base64 / data URL は、ツール引数・結果・履歴・通常ログへ追加しない。provider のエラー本文は要求 JSON を反射でき、JSON の入れ子・URL エンコード・折り返しの表記を列挙して除去する方式は未知の表記で漏れる。そのため `input_images` を付けた要求が失敗したときは provider の自由文を返さず、分類と固定文言（`画像生成に失敗しました（原因不明）` など）だけを返す。参照画像が無い従来の失敗は今までどおりマスク済みの理由を添える
- `read` が返す画像 content（SDK が会話履歴へ記録する分）はこの保証の対象外で、従来どおり
- 入力画像は EXIF 等を含めて無変換で外部 provider へ送られる。ツール説明・`promptGuidelines`・system prompt にこの点と「利用者が明示した編集にだけ使う」ことを書く

### 編集の既知の制限

- 参照画像は編集のガイダンスで、人物・構図・変更対象外のピクセルの完全な保持は保証しない（品質の下限はモデル依存でテストできない）
- endpoint 確認を編集のたびに 1 往復入れるため、その取得に失敗すると編集できない（新規生成は影響を受けない）
- モデル一覧の取得が成功していない間（SDK 同梱カタログへ落ちている状態）は能力宣言が読めず、編集だけが止まり続ける。[カタログ更新] か次の起動で解消する
- 既存ファイルで拡張子と実体が食い違う場合に実バイトを正とするため、保存名と中身が一致しないファイルが入力として通る（表示・保存側の既存挙動を変えない範囲で許容する）

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

`content_settings` の行の有無と `enabled` 列がコンテンツ生成のゲートで、`PiBff.contentGenerationEnabled` と `PiBff.setContentGeneration()` がその写し先になる。公開時にはさらにエージェントの `toolNames` との積を取る。画像・TTS・BGMは同じゲートを共有する（**有効 / 無効は 1 つの列**。タブごとのトグルは持たない。3 つは同じキーと同じ課金を共有し、止めたい依存も同じため）。

- `bootstrap.ts` は `AppDb.open()` の後、`ModelSettingsService.applyStored()` と同じ順序で `ContentSettingsService.applyStored()` を呼ぶ。行があり `enabled` が ON なら（キーをマスカーへ登録してから）有効化し、行が無ければ未設定、行があっても OFF なら停止のまま起動する
- キー登録・削除・有効 / 無効の API は**同じミューテーションロックの内側**で `setContentGeneration()` を更新する。次のセッション作成から効き、再起動は要らない。キー登録（上書き）は OFF を引き継ぎ、削除は行ごと消すため OFF も一緒に失われる（未設定へ戻る）
- ツール一覧はセッション作成時に固定する（新しい会話と復元から効く）。ON に戻しても、OFF の間に作った会話にはツールが無い（新しい会話で使う）。**OFF は実行時にも見る**ため、既存の live セッションでも次の呼び出しから `CONTENT_DISABLED_MESSAGE`（「コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。」）で失敗し、provider を叩かない。キー未設定・削除後とは別の文言にし、キーの再登録を促さない
- `execute` は作成時のキーを握らず、毎回 `content_settings` を読み直す。未設定・削除後はキー無効エラーを返し、キーの変更・回転にも追随する
- ツール一覧の止まっている理由は 2 つに分ける: キーの行が無ければ `no_key`、行があって OFF なら `app_disabled`（[api-catalog.md](api-catalog.md#ツール許可リスト)）
- 設定画面の「お試し再生」も OFF の間は課金しない（同じ文言の 400 を返し、画面は生成のボタンを止める。生成済みの音声の再生は課金しないため残す）
- pi ランタイム初期化に失敗したとき（`pi` が null）は `retainSecret` が no-op になり、キーを保護対象へ足せない。この状態のキー登録は model-settings と同じく 503 `not_stored` にする（DB へも書き込まない）

## 失敗の分類

SDK(pi-ai 1.3.0) の `openrouter-images` は `chat/completions` へ投げるが、画像生成専用モデルはそちらでは 404（`Use the /api/v1/images endpoint instead.`）になる。そのため `server/src/images.ts` は SDK の `generateImages()` を通さず `POST {baseUrl}/images` を自分で叩き、status と本文も自分で読んで次で分類する。SDK は provider の `baseUrl` / ヘッダのひな形にだけ使い、送信する model id は要求のものをそのまま使う（一覧の正は live なので、SDK の一覧に無い id でもローカルでは弾かない。[モデルカタログ](#モデルカタログ)）。

- 非 2xx の status を分類の根拠にする。理由は本文の `error.message` を優先し、形が違うときだけ生テキストへ落とす（生テキストは非 2xx のみ）。**参照画像を付けた要求では provider の自由文を結果へ載せない**（下記）
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

参照画像を渡したときも `/images` と応答の `data[].b64_json` / `media_type`、失敗の分類・期限・中断の扱いは変えない（OpenAI 直結 API の `/images/edits` や multipart は使わない）。

## キーの扱い

- キーは GET 応答・ログ・health・エラー文言に出さない。`PUT /api/settings/content/key` は **DB へ書く前に** `retainSecret()` でマスカーへ登録する。起動時も `applyStored()` が保存行のキーを登録する
- 削除・上書き後もプロセス生存中は保護対象から外さない（`session.jsonl` の再投影で旧キーを出さないため）
- ツール定義（BFF ローカル）は `wrapToolDefinitionWithSecretMasker` で包み、execute が throw する文言もマスカーを通す。DB の例外文言は `AppDb` の `sanitizeError` 境界でマスクしてから health / 503 へ出す
- キーの長さは 8..2048 文字（`provider_credentials` と同じ）。カタログ外のモデルと `openrouter` 以外の provider は 400

残存リスクは model-settings と同様で、キーは暗号文でアプリ DB に残るが、master key（`U7AGENT_SECRET_MASTER_KEY` / `_FILE`）を持つ者と稼働中の BFF は復号できる。master key をアプリ DB と別経路で管理し、ログイン認証のない BFF を LAN / インターネットへ公開しない。master key 未設定 / 不正の間は保存済みのキーを使えず、画面はキーの状態（保存済み / 利用可否 / 未評価）を固定文言で示す。キーが NULL（未設定）の行は `enabled` が ON でも生成ツールを開かない。既存の平文キーは v30 → v31 の移行で破棄され、再入力が必要。

## 設定画面

設定 → コンテンツ生成の「画像生成」タブ（`/settings/content`。既定。音声（TTS）は `/settings/content/speech`）。表示の正は `client/src/lib/contentSettings.ts` の純関数、取得と操作は `client/src/hooks/useContentSettings.ts`、描画は `client/src/components/content-settings/ContentSettingsTab.tsx` に閉じる。APIキー・provider の見出し・注意書きは面の外で音声と共有し、本文は選択中の面だけを描く。

- 未設定ではキー入力だけを出す（面の中身もタブ行も無い）。`PUT /api/settings/content/image` は行が無いと 400 のため、モデル選択と削除はキー保存（`PUT /api/settings/content/key`）に成功してから現れる
- タブ行の下の provider 見出し（ロゴ + 表示名 + provider id + 登録状態バッジ + `画像 <n>` / `音声 <n>`）を出す。件数チップはタブ文脈でどちらの件数か分かるよう、面の名前を接頭する。ロゴは `client/src/components/ProviderIcon.tsx` の `providerIconKey()` で引き、表示名と id は `contentProviderId()` / `contentProviderLabel()` が決める。v1 は openrouter だけなので未設定（`null`）でも OpenRouter を出し、provider が増えれば `settings.provider` に追随して同じ見出しのロゴが切り替わる（対応表に無い provider は頭文字のタイルへ落ちる）。件数と登録状態のチップはプロバイダータブと同じ `MetaChip` を使う
- 登録状態バッジ（設定済み / 未設定）は上部の見出しに出す（プロバイダータブと同じ見た目。`contentKeyStatusBadge()`）。キー欄の補足には provider 名（OpenRouter）を添え、モデル欄に出る `OpenAI: …` と混同させない
- キーは `type="password"` / `autoComplete="off"` で、保存値を再表示しない（常に空から入力する）。[上書き保存] は成功したときだけ入力を消し、[削除] は共通の確認ダイアログ（`deleteContentKeyConfirmRequest()`。対象の provider は clamp した行に出す）の後に行ごと消して未設定へ戻す
- モデルは native `<select>`（`SelectField`）でカタログから 1 件選ぶ。保存済みのモデルがカタログに無いときは「（カタログ外）」として現在の id を先頭に足す（何が保存されているかを見失わせない）。サイズ / 品質 / 出力形式の UI は持たず、本文にはその理由（provider の既定を使う）だけを書く。provider 名は見出しにあるため繰り返さない
- 注意書きは詳細の上部で既定に畳んで出す（1 行の要点 + 展開で全文。暗号化して保存・再表示しない・master key 未設定では使えない・ログイン無しで公開しない・有効性は保存時に見ない・キーは 8 文字以上・プロバイダー登録キーとは別管理）。下部に「保存したキーは新しい会話から使える（ツール一覧はセッション作成時に固定）」と、生成物の保存先（作業フォルダの `generated/`）を注記する
- `runtimeAvailable: false` のときはキー登録・上書き・削除を disable し、プロバイダータブと同じ理由（サーバーの起動ログ）を出す。モデルの変更は SDK に触れないため残す。変更系の 503 `state: "not_stored"` は「変更は保存されていません。」を付けて画面の注記へ出す
- 画面の [再読み込み] はこの画面の設定だけを取り直す（設定 → モデルの [再読み込み] はモデル側だけを取り直す）。キーの登録・削除は再起動を待たず、次に作るセッションから効く
- 有効 / 無効のトグルは**タブの外に 1 つだけ**置く（画像・音声・BGM のどのタブでも同じカードが出る）。ラベルは「アプリ全体の生成を止めます（画像・音声・BGM で共通）」で、OFF の間は API が返す `disabledMessage` をその場に出す。未設定（キーが無い）では止める対象が無いため出さない。保存に成功したらエージェントのツール一覧を取り直す（エージェント編集のツール欄が取得時点のスナップショットを見るため）

## ツールとプレビュー

- ツール引数は `prompt`（必須）、`path`（省略可、cwd 相対）、`input_images`（省略可、参照画像 1 枚）。ツール説明と system prompt（`appendSystemPrompt` の画像生成行）に、生成物の場所と「本文には Markdown 画像で示す」ことを入れる
- ツール結果本文には保存パスと一緒に使用モデル（実行時に読んだ `model`）を行で残す。会話履歴は `session.jsonl` の `toolResult` の生 content を正とするため、別途 DB へは保存せず、ライブ・復元後の両方でツール履歴の出力から何で生成したかを追える。設定を変更した後の実行にはその時点のモデルが入る
- モデル行は結果本文の先頭に置く。投影（`toolResultSummary`）は先頭 900 文字（`SUMMARY_TEXT_MAX`）で切るため、長い `path` を指定しても表示からモデルが欠けないようにする
- 生成物の確認は `read`。SDK の `read` は画像を返せる
- チャットのプレビューは Markdown 画像の cwd 相対解決で行う。`![alt](generated/cafe.png)` を 1) `resolveFileRef(src, rootCwd, cwd)` → 2) `fileTreeFetchPath(cwd, resolved)` → 3) `fileRawUrl(rootRelative, imageVersion)` の 3 段で解決し、添付画像と同じ `ZoomableImage`（variant `markdown`）で表示する（[markdown.md](markdown.md#画像の-src-解決)）。解決できなければ従来どおり src をそのまま描く（外部 URL は CSP で読み込めない）
- raw URL の `v` は[document 内の共有採番](api.md#画像配信raw)で得る版。`ChatState.runEndSeq` の変化を合図に URL を変え、同一パスが差し替わっていてもブラウザの in-document 画像キャッシュを使わずに取り直す。これは現在のファイルへの追随であり、履歴を不変にするのは上記の[生成手順](#会話履歴を保つ生成手順)。添付画像はアップロードごとの一意名で不変なので版を付けない

### チャットのバッジ

結果本文のモデル行をクライアントが読んで、ツール履歴を展開しなくても何で生成したかが分かるようにする。抽出は `client/src/lib/generationInfo.ts` の純関数で、ライブも復元後も同じ本文（`ToolCard.output`）を入力にする（サーバー / DB / API は変えない）。

- ツール履歴のヘッダと行にモデルを出す。ヘッダは全行が同じモデルなら 1 つ、混在は 1 つにまとめて内訳を hover に置く（片方のモデルだけを見せない）。複数ツールの切り分けは行のチップが担う
- 本文の上に種類（画像 / 音声）・モデル・ボイス・保存パスを出す。そのターンに何を生成したかの要約はここが担い、ツール履歴との役割を分ける。件数の上限は設けず、狭い幅では折り返す（出し分けを増やさず、並びは呼び出し順のまま）
- ツール履歴の下端の罫線との間隔は本文の有無に依存させない（本文を持たないターンでも密着しない）
- チップとバッジの値は結果本文の生の値（実行に使った id）で、カタログの表示名へは解決しない（[非ゴール](#非ゴール)）。読むのは結果本文の先頭の数行だけで、モデル行が投影（先頭 900 文字）の切詰めで欠けない位置にある前提を使う
- 改行で終わっていない行は値にしない。投影で切られた行の断片（ファイル名を失った保存パスなど）を実パスとして出さないためで、この場合モデルだけを出し、保存パスは出さない
- 出さない条件: 対象ツール以外、結果本文にモデル行が無い（モデル行を書く前のセッション）、失敗したカード（throw は結果本文を残さない）、実行中（結果が届くまでモデルは確定しない）。値が読めないときに「不明」のような行を足さない
- 同じカードが 2 つのバブルに現れない（`chatReducer` がツールカードのバブルを固定する）ため、バブル横断の重複排除は入れない
- 「ツール履歴をすべてコピー」の本文は変えない（args / output の生テキストと `#N` の対応を保つ）

### 生成物のキャプション

生成した画像の直下に、使用モデルと保存パスを出す（音声はプレイヤーの直下に同じ見たまで出す。[speech-generation.md](speech-generation.md#チャットのプレイヤー)）。バッジが本文の上に出るのに対し、こちらは生成物そのものの直下に出る（`client/src/components/GenerationCaption.tsx`）。

- 対応付けの単位はターン（user バブルの次から次の user バブルまで）。生成カードの保存パスを root 相対へ解決した表を作り、そのターンの各バブルへ配る（`client/src/lib/generationInfo.ts` の `generationCaptionsOf`）。履歴の投影は**本文を持たない** assistant message を表示せず、その tool call を次の表示 message へ繰り上げる（`carriedTools`）ため、カードが前のバブルに残るのは本文と tool call を同居させた assistant message の後ろに最終本文の message が続く場合になる。繰り上げ先がターン内に無いときはその応答自身の本文なし item になる。どちらでも対応が取れるよう、バブル内では閉じない（ライブと復元で同じ見えにする）
- 画像は本文の段落の中の **Markdown の `![alt](src)`** だけに出す（生 HTML の `<img>` は [拡大表示](markdown.md#画像の拡大表示)の対象だが、キャプションは持たない）。`src` は cwd 相対で書かれるため、`generated/x.png` と `./generated/x.png` の差では落とさない（[markdown.md](markdown.md#画像の-src-解決) の解決結果で引く）
- 見た目はアイコン + モデル（音声はボイスも）+ 保存パスで、パスは結果本文の cwd 相対のまま。長い値は省略し、全文は `title` に置く
- 画像の読み込みに失敗しても、対応が取れていれば出す（失敗時の表示は[画像の拡大表示](markdown.md#画像の拡大表示)の既存の契約に任せる）
- 出さない条件: 対応が取れない画像（別のターンでの再掲・`cp` したコピー・リネーム後・外部 URL）、見出し / 表のセル / 引用の中、リンクの中の画像、添付画像、保存パスが結果本文に無いカード（モデル行を書く前のセッション / 投影で切れた）、`cwd` が未取得（画像の src も解決できない）

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/content` | `configured` / `provider` / `runtimeAvailable` / `image`（`model` / `models`（カタログ）/ `catalogSource` / `fetchedAt`）。キーは返さない |
| PUT | `/api/settings/content/image` | `{ provider, model }`。キーを保持したまま画像モデルの選択を更新（行が無ければ 400） |
| PUT | `/api/settings/content/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/content/key` | 行ごと削除（未設定へ戻す。冪等） |
| POST | `/api/settings/content/image/catalog/refresh` | live カタログの再取得。常に 200 で `models` / `catalogSource` / `fetchedAt` / `catalogError` を返す（失敗時も一覧は返す） |

- `catalogSource` は `live` / `stored` / `sdk` で、`image.models` の出どころを表す（[モデルカタログ](#モデルカタログ)）。`live` 以外は取得に失敗している状態で、`fetchedAt` は最後に live を取得できた時刻（`sdk` のときは `null`）

- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映が無いため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`（直後に画面から変更できる）
- 詳細と例は [api.md](api.md#コンテンツ生成)

## テスト

実 API は呼ばず、ダミーキー + stub provider / fake サンドボックスで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/images.test.ts` | カタログ / `chat/completions` へ戻らないこと（`/images` の送信先・ヘッダ・本文）/ `media_type` の落とし方 / 失敗分類（401・403・402・429・5xx・timeout・ユーザー中断・原因不明）/ 画像 0 件の失敗（2xx の生本文と `error.message`）/ provider メッセージのマスク / SDK 同梱カタログから `openrouter/*` を落とすこと / SDK 同梱の openrouter が provider 内で同じ `baseUrl` / ヘッダを使うこと（ひな形の流用の前提）/ SDK の一覧に無い id（live のみのモデル）も provider の URL で送ること / 参照画像ありの失敗では provider の自由文（plain / 1 段・2 段の JSON エスケープ / 折り返し base64）を返さず固定文言だけになること / 参照画像なしの失敗では従来どおり理由を添えること |
| `server/test/image-catalog.test.ts` | live の採用とキャッシュ保存（認証ヘッダを付けない / id と表示名と形式の宣言）/ 出力形式の取り込みと一覧の絞り込み（不明・形違いは落とさない）/ 宣言がキャッシュから読めること / 一覧から落ちた id の `outputFormatsOf` / 重複 id と表示名の欠落 / 失敗分類（429・5xx・契約外・空・timeout）と一覧の保持 / キャッシュの読込と live 失敗時の維持 / キャッシュの読取・保存失敗 |
| `server/test/image-tools.test.ts` | ツールの組み立て（有効時だけ）/ path の拒否規則 / slug と拡張子 / 結果パスの参照・一意ファイルの保持・最新コピーのガイドライン / 生成前ガード（保存できない形式だけを宣言したモデルで provider を叩かない・宣言なしと不明は止めない）/ 保存段の失敗文言（クレジット消費済み）/ root 相対への前置き / 同名衝突で実際の保存名と使用モデルを返す / 長い path でも投影の切詰めにモデルが残る / execute が毎回設定を読む / OFF の間は provider を叩かず固定文言で失敗し ON へ戻すと同じ定義で生成できる / throw のマスク / signal の伝播 |
| `server/test/image-input.test.ts` | 参照画像のパス解決（cwd 相対 / 添付の絶対パス / 未所属・プロジェクト・追加スペースで起点がずれない）/ 拒否規則（`..`・範囲外・URL・data URL・バックスラッシュ・空）/ 実バイトの形式判定（PNG・JPEG・WebP、無拡張子・拡張子違い、壊れたヘッダ）/ 上限（10 MiB・40 メガピクセル）/ 入力の base64・data URL の除去 |
| `server/test/sandbox-image-input.test.ts` | `GET /v1/files/image-input` の許可範囲（scope 外・実在しない範囲・root 外 symlink）/ 実バイト判定 / 上限 413 / scope 数の上限 |
| `server/test/content-settings.test.ts` | GET / PUT / DELETE の契約、有効 / 無効の切替（キーと選択を保つ・行が無ければ 400・保存失敗は 503 で写しも変えない・キー上書きが OFF を引き継ぐ）、マスカー登録の順序、既定行、行が無い / provider / カタログ外の 400、runtime 無しの 503、DB 失敗の 503、起動時の適用（キャッシュ読込と、行があるときだけの live 取得）/ キー保存が取得を待たないこと / 再取得の失敗文言 / 注入する config の形式宣言 |
| `server/test/content-settings-api.test.ts` | HTTP 契約と DB 例外のマスク、`PUT /api/settings/content` の有効 / 無効（行が無ければ 400）、起動時の有効化、キーが応答・health・ログへ出ないこと、カタログの出どころ / 再取得の 200 と `catalogError` / `models` の形（宣言を載せない） |
| `server/test/app-db.test.ts` | v7 → v8 / v8 → v9 の加算移行、v14 → v15 の改名（`image_settings` → `content_settings`、`model` → `imageModel`）、両テーブル併存時の読み先、v15 → v14 → v15 の往復、`content_settings` の CRUD、空文字行 = 未設定、`enabled` の列追加（既存行は ON）と往復、`image_catalog` の upsert と壊れた行（health を落とさない）、形式宣言の往復と形違いの読み方 |
| `client/test/markdownImage.test.ts` | Markdown 画像の 3 段解決 / version が変わったときだけ解決 URL が変わること / App の `runEndSeq` 配線 / 解決できない src / `components/markdown/` が `api.ts` を import しないこと |
| `client/test/imageRefresh.test.ts` | 実フックの再描画安定性・更新時の URL 非衝突 / 実 Markdown と FileBrowser の再 mount が過去の URL を再利用しないこと（SSR） |
| `client/test/contentSettings.test.ts` / `client/test/contentSettingsTab.test.ts` | 選択肢（表示名の昇順・同名への id 添え・カタログ外の現在値）/ 現在値と PUT の本文 / 保存成功時だけキー入力を消す / キーの登録状態バッジと provider の id・表示名 / 見出しの provider（ロゴ・未設定でも OpenRouter・対応表に無い provider は頭文字）と `画像 <n>` / `音声 <n>` のチップ / 一覧の出どころのチップと最終取得 / 再取得の注記 / 選んだ面だけの描画（未設定はキーのみ・設定済みは削除と選んだ面の選択・キーを再表示しない・runtime 不可の disable・[カタログ更新] の出し分け）/ 有効 / 無効のカード（どのタブでも 1 つだけ・無効時の固定文言と警告色・未設定では出さない）と注記の文面 |

## 非ゴール

- OpenAI provider の実装（差し替え点だけ残す）
- キーの有効性のチェック（live カタログの取得は API キーを見ないため兼用できない。やるなら別 API）
- TTL / バックグラウンドでのカタログ自動再取得（契機は起動と手動 [カタログ更新] だけ）
- コスト表示、provider 切替 UI、プロバイダー登録済みキーの流用
- 参照画像による**部分編集**（マスク / 領域指定 / レイヤー）。変更対象外のピクセルを厳密に保つことは保証しない（[参照画像による編集](#参照画像による編集)）
- 複数の参照画像、複数枚の出力、入力の自動縮小・自動変換、外部 URL を直接の入力にすること
- `provider.only` による endpoint の pin（対応 / 非対応が混在するモデルは編集対象外）
- 専用の編集ボタン・before/after 比較・画像版管理 UI（自然言語と既存のファイル保存・表示で行う）
- サイズ / 品質 / 出力形式の変更、複数枚生成、ツール結果への画像 content（svg-only の除外と生成前ガードは [保存できない形式のモデル](#保存できない形式のモデル)）
- SVG（vectorization）の保存・プレビュー・raw 配信。svg-only モデルを選択肢から外し、保存形式と同じく png / jpeg / webp だけを通す（[保存できない形式のモデル](#保存できない形式のモデル)）
- バッジのモデルを[カタログ](#モデルカタログ)の表示名へ解決すること。表示名はいつでも変わるので、履歴に残った実行時の id をそのまま出す
- 生成物のキャプションのための同一ファイル追跡（ハッシュや内容）。別ターンでの再掲・`cp` したコピー・リネーム後の画像には出ない（[生成物のキャプション](#生成物のキャプション)）
- キャプションからの追加の導線（クリックで設定を開く / モデルを切り替える）、動画・SVG へのキャプション、画像の alt 表示の変更
