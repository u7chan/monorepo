# コストマスタ連携

モデル選択の時点で「だいたいいくらか」が分かるように、コンテンツ生成のモデル一覧へ価格と「一覧に出す / 出さない」の判断を写す。価格と判断は別サービス（`projects/cost-master`）が持ち、u7agent は取得して表示するだけ。実装は `server/src/content-cost.ts`（取得・検証・投影）と `server/src/content-settings.ts`（DTO への合成）、設定 API は `server/src/routes/content.ts`。

会計は目的にしない。実額の記録・残高・予算の強制・請求台帳は扱わず、鮮度や網羅性の厳格さも求めない（選ぶときの指標）。

## 設定

- コストURLと ON/OFF は `content_cost_settings` の 1 行に置き、`content_settings` へは足さない。キー削除は `content_settings` の行ごと消すため、キーと独立した運用設定を同居させない
- `PUT /api/settings/content/cost-url` は `{ enabled, url }` を 1 回で保存し、保存時に取得しない。行が無くても受け付ける（キー未登録でも価格だけ設定できる）
- `enabled: true` は URL 必須。`enabled: false` は URL を保持したまま保存でき、`enabled: false` + 空 URL は行の削除として扱う
- 保存時は URL の形だけを見る（`http` / `https`、ホスト名必須、IP リテラルと認証情報は拒否）。DNS 解決と SSRF 判定は取得時に行い、保存時に外部へ問い合わせない
- BFF に利用者認証は無い。設定画面へ到達できる利用者が URL を設定できる前提で、到達範囲を LAN / VPN に限る運用は変えない

## マスタの応答

`GET /api/models` が `{ version, fetchedAt, models: [...] }` を返す。1 行は `provider` / `modelId` / `billable` / `unit` / `variant` / `costUsd` / `currency` / `enabled` / `note` を持つ。

- `provider` は `openrouter` だけを通す
- `billable` は `output_image`（画像）/ `input_text` / `output_audio`（音声）の許可リスト。それ以外は行ごと捨てる。**画像は出力側だけ**を表示し、音声は入力側（文字・バイト・トークン）も指標になる（`billable` と `unit` は直交するため、`unit` で側を判定しない）
- `unit` は `image` / `megapixel` / `token` / `character` / `byte` / `minute` / `request`。未知の `unit`、負・非数値の単価、`USD` 以外の通貨、形の違う行はその行だけを捨てる（`0` に丸めない）
- 宣言された `0`（`:free` など）は無料として残す。行が無い・読めない「不明」とは別で、画面では前者が `$0`、後者が `--` になる
- 同じ `(modelId, unit, side, variant)` が複数来たら最大の単価へ潰す（マスタが endpoint を潰している前提の防御。配列順に依存させない）。モデル単位の `enabled` は false を優先し、`note` は先頭の非 null
- `variant` は解像度ティアとは限らず、`style_references` などの加算オプションを含む。`variant: ""` が基本単価で、無いときだけ同じ `unit` の中で範囲を出す
- `billable` は上流の語彙で、マスタの応答から先（DTO）へは持ち込まず、`side`（`input` / `output`）に正規化する
- 通貨は `USD` 固定。上流が通貨を宣言しないためマスタが付与する。将来 `USD` 以外が来たら捨てる

## 取得

- 取得は **ON かつ手動の [カタログ更新]** のときだけ。起動時・定期・`GET /api/settings/content` では上流に出ない。OFF と未設定では master へリクエストしない
- `http` / `https` のみ。ホスト名を必須にし、DNS で解決した**すべての IP** を取得のたびに検査する
- 既定で許可するのはグローバルな接続先だけ（loopback / プライベート / リンクローカル / IPv6 ULA / CGNAT / マルチキャスト / unspecified / documentation を拒否）
- 同一 Docker ネットワーク上のマスタをサービス名で指すとき（`http://<サービス名>:<ポート>/api/models`）は解決先がプライベートになるため、`PI_CONTENT_COST_ALLOW_PRIVATE=1` で**プライベート / CGNAT / IPv6 ULA だけ**を追加で許可する。ループバックとリンクローカルは opt-in でも拒否する（マスタへ届かず、メタデータへの経路になるため）。TLS 終端を Caddy に任せないので、内部 CA を u7agent へ配る必要もない
- `PI_CONTENT_COST_ALLOW_PRIVATE` は未設定・未知の値なら無効（従来どおりグローバルだけ）へ倒す。接続先の制限は安全側の設定なので、設定ミスで緩まない向きに倒す
- DNS は 1 回だけ解決し、検証した IP へ接続する（再解決させると rebinding の窓が残る）。リダイレクトは追わず、認証ヘッダは付けない
- 期限は 10 秒、応答本文は 1 MiB、行は 2,000 件。超えたら契約外として `errors.cost` に倒す
- 失敗は timeout / 混雑（429・5xx）/ 接続先の拒否 / 契約外 / 不明の固定文言へ分類し、上流の本文・URL・接続先はログにも応答にも出さない
- 取得成功だけがスナップショット（`content_cost_catalog`）を置き換える。失敗・タイムアウト・契約外では前回の値と `visible` をそのまま使う（消さない・0 にしない・反転させない）
- OFF でも保持値は残し、`GET` の `cost.fetchedAt` / `version` は返す（画面が「停止中（前回取得: …）」を出せる）。ON に戻すと同じ URL なら前回値から再開し、再取得は [カタログ更新] を待つ
- URL を変更したときは前回のスナップショットを破棄する（別マスタの価格を現在値として出さない）。URL が一致しないスナップショットは起動時にも読まない
- スナップショットは派生データなので、壊れた行は「未取得」として読み、health や設定 API の 503 にしない

## 投影とマージ

`server/src/content-settings.ts` が live の一覧（`snapshot()`）へ価格と `visible` を足す。**一覧の正は live** で、この投影は一覧の集合を変えない。

| 状況 | 扱い |
| --- | --- |
| live にあるがマスタに無い | `prices: []`（表示は `--`）、`visible: true`、`note: null` |
| マスタにあるが live に無い | 捨てる（一覧の正は live） |
| マスタの `enabled: false` | `visible: false` にするだけ。一覧からは落とさない |
| コスト設定が OFF / 行なし | `prices: []` / `visible: true` / `note: null`（サーバーが投影し、client は値を見るだけ） |
| 単価が負・非数値・未知の `unit` | その行を捨てる（`0` にしない） |
| 取得失敗・タイムアウト・契約外 | 前回の値を維持する |

- `prices` は `(unit, side, variant)` で一意にし、`{ unit, side, variant, costUsd, currency }` だけを返す。画像は `side: "output"` の行だけを返し、音声は入力と出力の両方を返す（音声の並びは `client/src/lib/contentSettings.ts` の `speechPriceDisplay()` が 1 箇所で決める）
- **除外は表示の投影だけ**。`visible: false` でも `PUT /api/settings/content/image` の照合（保存済みの選択の再保存・パラメータ保存）と試行の照合は現在の一覧をそのまま使う。生成はもともと一覧を見ない
- 既存の svg-only の絞り込み（`isUnsaveableOutputOnly()`）は変えない。`visible` はこれと独立した表示条件
- 変更系の応答（キー保存・トグル・選択など）にも同じ `cost` と価格が乗る（`ContentMutationResponseSchema` が `ContentSettingsResponseSchema` を拡張しているため）

## 画面表示

- 画像のモデル欄のチップと選択肢に価格を出す。整形の正は `client/src/lib/contentSettings.ts` の `imagePriceDisplay()`（基本単価優先・範囲・`--`・`$0`・token の換算）
- 音声は入力側を主、出力側を副にしてチップを 2 つまで出し、選択肢のラベルにも主の単価を添える。整形は `speechPriceDisplay()`（`character` / `byte` / `token` は 1M あたり、`minute` は分あたり。`$0` と `--` を区別する）
- `visible: false` は**描画の選択肢からだけ**外す。`imageModelOptions()` は全件のまま残し、`visibleImageModelOptions()` が現在値だけ専用ラベルで残す。保存中の値が無効なら「一覧に出していない・保存済み」の警告を出す
- 一覧に載せなかった件数は「N 件は一覧に出していません」と注記する（黙って消えたように見せない）
- コストURLと ON/OFF は画像・音声で共有するため**帯の左**に置き、[保存] 1 回で両方を送る。入口は**価格を出す面にだけ**出し（画像が OpenRouter のとき / 音声）、BGM と履歴、生成元が Codex のときは出さない。OFF の間は URL の入力欄を非活性にし、サーバーは `prices: []` を返すため価格のチップは `価格 --` に倒れる（チップ自体は残す）。由来のチップに「コスト表示は停止中（前回取得: …）」を出し、未設定とは区別する
- [カタログ更新] は「一覧の出どころ」の行に置き、帯の [再読み込み] とは置き場所で役割を分ける。Codex（画像モデルの一覧を出さない）と BGM では出さない（[ui-layout.md](ui-layout.md#モードごとの構成)）

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| PUT | `/api/settings/content/cost-url` | `{ enabled, url }`。接続先とトグルを保存し、取得はしない。`enabled: true` で URL が空・不正なら 400 |
| POST | `/api/settings/content/catalog/refresh` | 手動の [カタログ更新]。モデル一覧・音声一覧・価格をまとめて取り直し、**常に 200** で `ContentSettingsResponse` と同じ形 + `errors: { image?, speech?, cost? }` を返す |

`errors` は系統ごとに分かれ、1 系統の失敗で他の結果を捨てない。コストの失敗は `errors.cost` にだけ載り、前回の価格を保つ。

## 非ゴール

- 実額の記録、残高・クレジットの表示、予算上限の強制、請求台帳、会話の `usage.cost.total` への合算
- 価格や `visible` を理由にした生成の拒否・再生成・モデル切替
- 起動時・定期・バックグラウンドでの価格取得
- BGM の価格表示（モデル固定で選択肢が無く、上流の JSON も 0 を返す）
- 複数 URL・複数 provider の同時指定、マスタの編集（u7agent からは書き込まない）
