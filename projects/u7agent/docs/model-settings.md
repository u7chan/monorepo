# 利用可能なモデルとプロバイダーAPIキーの設定（設定 → モデル）

設定 → モデルから、**モデル候補（選択リスト）**・**アプリ既定モデル**・**プロバイダーごとのAPIキーとメモ**を GUI で設定する。保存した内容はアプリデータの SQLite に残り（再起動後も使え）、SDK の非永続の runtime overlay と公開 state へ写して起動中のモデル候補へ反映する。プロバイダーの認証に `.env` の環境変数と `~/.pi/agent/auth.json` を使う経路はこれまでどおり使え、GUI はそれらを変更しない。

- 保存の正は **アプリ DB**（`provider_credentials` / `model_settings` / `provider_memos`）。SDK の runtime overlay は実効状態で、再起動で消える
- APIキーの変更系は「DB を希望状態として先に確定」し、SDK への反映に失敗しても DB を戻さない（補償ロールバックを持たない）。反映できなかった変更は **degraded（保存済み・未反映）** として画面に出し、`resync` / 次回の変更 / 再起動で収束させる
- 利用可能なモデルとアプリ既定モデルは SDK 呼び出しを含まないため degraded を作らない。「DB 確定 → 公開 state の再計算」だけで効く
- provider メモはキーの登録有無と独立した人間用の任意文字列で、SDK 呼び出しを含まない。`applied` だけを返し、キーを削除しても残る

## 画面の分離

| 画面 | 役割 | 内容 |
| --- | --- | --- |
| 設定 → ランタイム（表示専用） | 環境診断 | 接続状態 / 実行環境 / 利用可能なコマンド / SDK バージョン |
| 設定 → モデル（編集可） | タブ 1: モデルを選ぶ（`/settings/models`）/ タブ 2: プロバイダー（`/settings/models/providers`）/ タブ 3: 画像生成（`/settings/models/images`）/ タブ 4: Web 検索（`/settings/models/web-search`） | タブ 1 はモデル候補の選択とアプリ既定モデル、タブ 2 は provider ごとの認証状態、APIキーの登録・上書き・削除、メモの保存、再同期、カタログの利用可能数、タブ 3 は画像生成専用の APIキー・モデル（[image-generation.md](image-generation.md#設定画面画像生成タブ)）、タブ 4 は `web_search` の実行時トグル・既定 provider・provider ごとの APIキー（[web-search.md](web-search.md#実行時トグル設定--モデルの-web-検索タブ)）。モデル一覧の重複表示は持たない |

プロバイダーとカタログの表示はランタイム画面からモデル画面へ移した。ランタイム画面は `GET /api/runtime/models` を呼ばない。health に載せていたモデル診断（`runtimeDiagnostics`）は撤去し、SDK バージョンだけを health 直下の `versions` に残した。

## 保存先とスキーマ

`PI_SESSION_STORE/u7agent.db` の `provider_credentials`（`APP_DB_SCHEMA_VERSION` 3 → 4、`updatedAt` は 6 → 7 の列追加）、`model_settings`（4 → 5）、`provider_memos`（5 → 6）。この DB では初めて `ALTER TABLE ... ADD COLUMN` で既存テーブルへ列を足す。

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider  TEXT PRIMARY KEY,
  apiKey    TEXT NOT NULL,
  updatedAt INTEGER  -- epoch ms。上書き保存のたびに更新。NULL = 移行前の行で不明
);

CREATE TABLE IF NOT EXISTS model_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  allowedModels TEXT,  -- JSON 配列。NULL または空配列 = 制限なし
  defaultModel  TEXT   -- "provider/model"。NULL = 未設定 (既定なし)
);

CREATE TABLE IF NOT EXISTS provider_memos (
  provider TEXT PRIMARY KEY,
  memo     TEXT NOT NULL  -- 人間用の任意文字列。行が無い = 未設定
);
```

- 値は必ずバインドして渡す。保存行は**平文**で、Webhook URL と同じトラストレベル（[persistence.md](persistence.md#アプリデータsqlite)）
- `managed`（DB 行 = 永続化された希望状態）と `auth.source`（SDK の実効値。`runtime` / `environment` / `stored` …）は**別物**として画面に出す
- `keyUpdatedAt`（DTO の `providers[].keyUpdatedAt`）はこの画面で登録したキーの最終保存時刻（epoch ms）。`managed` が false の provider は常に `null`。上書き保存のたびに `Date.now()` で更新し、`resync` / 削除では変えない（削除は行ごと消えるため以後 `null`）。移行前の行も `null`（保存日不明）で、起動時に `Date.now()` を書き戻さない
- 最終使用は保存しない。クライアントが `GET /api/sessions` の `model` + `lastUsedAt` から provider ごとに集計する派生値で、サーバーの DTO / health には足さない
- メモは credential ではなく provider に紐づき、**行が無い = 未設定**。空にして保存すると行ごと消し、手編集された空文字の行も未設定として読む（DTO は `memo: null`）
- DB の読み書きとスキーマ移行の失敗は [persistence.md](persistence.md#失敗時の扱い) と同じで、health の `appDb` と 503 に出る

## モデル候補（選択）とアプリ既定モデル

`model_settings` は 1 行だけで、**行が無い = 未設定**（制限なし・既定なし）。

- `allowedModels` は `provider/model`（model id の `/` は許す）の一覧で、API の応答もこの文字列で返す。保存時に**重複を先勝ちで畳み**、**空配列は制限なし（NULL）へ正規化**する。両方が NULL になった保存は行ごと消して未設定へ戻す
- UI は選択を**常に明示リスト**で扱い、`allowedModels: null`（旧・制限なし）は「利用可能な全モデルが選択済み」として表示する。空配列は API が制限なしへ正規化して意図と逆になるため、選択 0 件の間は保存ボタンを無効にする（`normalizeAllowedModels()` の空→NULL はサーバーと同じ安全網として残す）。候補として扱うのは認証済み provider のモデルとカタログ外の残存だけで、認証が無い provider の選択は候補に行に出さず下書きからも落とす（`pruneAvailabilityDraft()`。保存値に残っていても次の保存では送らない）
- `defaultModel` は保存値で、`GET /api/settings/models` が返す。**実効値は `GET /api/health` の `model`**（保存値だけ。利用可能な候補があるのに未設定なら候補の先頭で代用せず、`defaultModelUnset: true` を返す。候補 0 件は可用性エラーで、このフラグは立てない）。UI では選択済みモデルを検索できるピッカーで選び、「未設定」を先頭に残す。保存値の `null` 展開時に既定モデルが利用可能な集合に無ければ 1 件だけ足す（別の差分の保存を 400 にしないため）
- **選択されているかどうかの正は `GET /api/settings/models` の `allowedModels` だけ**。`GET /api/runtime/models` のカタログは候補の表示と available 判定にしか使わず、同じ情報（`inWhitelist` のような形）を持たない
- 実効値の向きは「DB を正とする `ModelSettingsService` → pi の state」。`PiBff.setModelSelection({ allowedModels, defaultModel })` で実行時選択を差し替え、`refreshModelState()` を 1 回呼んで公開 state を再計算する。起動時の初回 state は「制限なし・既定は未設定」で立ち、DB を開いた後の `applyStored()` が保存値へ確定させる
- 絞り込みは `filterModelsByWhitelist()` の 1 箇所だけに保つ（個別にフィルタを足すと `PATCH /api/sessions/:id/settings` の経路から漏れる）
- 選択リストの変更は**起動中の live セッションのモデルを変えない**。効くのは新しい会話と、未ロードの会話の復元時フォールバックだけ（[model-effort.md](model-effort.md#既存の会話への影響認証の変更)）

### 保存時の検証

| 入力 | 判定 | 失敗時の応答 |
| --- | --- | --- |
| `allowedModels` の形式 | 各要素が `provider/model` 形式（先頭の `/` で分けた provider / id が非空で、provider に `/` を含まない） | 400 `モデルは provider/model 形式で指定してください` |
| カタログ | カタログ（`ModelRuntime.getModels()`）にある `provider/model` のみ | 400 `カタログに無いモデルは指定できません: <provider>/<id>` |
| `defaultModel` | 選択リスト内のみ（制限なしのときはカタログ内） | 400 `既定モデルは利用可能なモデルから選んでください: <provider>/<id>` |
| 重複 | 正規化（先勝ち）して保存 | — |
| 空配列 | 制限なしへ正規化 | — |
| 未認証の既定 | 保存を許す（画面が警告と確認を出す） | — |

検証は `getAvailable()` ではなく `getModels()`（カタログ）を引く。未認証のモデルでも API の選択リストには入れられる（画面は認証済み provider のモデルとカタログ外の残存だけを候補にし、認証が無い provider の選択は下書きから落とす）。カタログから消えた残存エントリは保存できない（画面は選択済みエントリとして警告付きで行に出し、外せる）。応答は `GET /api/settings/models` と同じ形 + `state: "applied"` で、`state` は「DB 確定 + 公開 state の再計算」を表す。

### 移行前の環境変数

`PI_MODELS` / `PI_MODEL` / `PI_PROVIDER` は読まない。設定されていても無視し、`GET /api/settings/models` の `ignoredEnvironmentVariables`（設定されている名前だけ）と起動ログの警告で削除を促す。カタログ外の残存エントリがある間は保存できず（400）、画面の選択リストの行から外す。

## プロバイダーごとのメモ

`provider_memos` は「この provider にどのキーを入れたか」（無料枠 / 課金枠、個人 / 会社アカウントなど）を人間が思い出すための任意文字列で、**キーの登録有無（`managed`）とは独立**している。キーは再表示しないため、画面からでは見分けられない。

- 保存先を `provider_credentials` に相乗りさせないのは、`managed`・[削除]・degraded が「この画面で登録したキーの行」を意味する契約を守るため。メモだけの行が credential にあると、キーが無いのに `managed: true` になり、`deleteKey` が SDK の overlay を消しにいく。`apiKey` が `NOT NULL` なので列を足すだけでもメモ単独の行は作れない
- `putMemo` は `trim()` して空なら行を消し（未設定へ戻す）、それ以外は upsert する。行が無い = 未設定を保つため、空文字の行は残さない
- メモ欄はキーの登録可否（`canSetApiKey`）と無関係に出し、ambient / keyless の provider にも書ける。キーの行と同様に `managed` / `degraded` / `orphan` の意味は変えない
- キーを削除してもメモは消さない。ユーザーが書いたテキストを黙って消さないため、消したいときはメモ欄を空にして保存する
- カタログから消えた provider のメモは `orphan: true` のカードとして出続け、空にして保存すると消える
- メモは秘密情報ではない。マスカー（`retainSecret`）に登録せず、代わりにログ・health・エラー文言のどの経路にも値を載せない（[secrets.md](secrets.md)）

## キーの棚卸し（最終保存と最終使用）

使っていないキーの解約・整理の材料として、各カードに「キー最終保存」と「最終使用」を出す。どちらも事実だけを示し、キーの有効性や API 呼び出しの成功を断定しない。

- 「キー最終保存」は `managed` の provider だけに出す。`keyUpdatedAt` が `null` の行（移行前）は「保存日不明」と書く。`managed` でない provider（環境変数認証など）には日時行を出さない
- 「最終使用」は `model` + `lastUsedAt` を provider ごとに集計した値（`client/src/lib/modelSettings.ts` の `providerUsage()`）で、`provider/model` の区切りは**最初の `/`** だけ（model id に `/` を含み得る。server の `parseModelRef` と同じ規則）。`model` の無い会話は母数から除く
- 表示は `最終使用: <messageTimeLabel(lastUsedAt)> · この provider の会話 N 件` で、1 件も無ければ「この provider の会話はありません」。`managed` でなく会話も 0 件のときは、どちらの行も出さない（ノイズを作らない）。日時整形は `client/src/lib/messageTime.ts` の `messageTimeLabel()`（今日 = 時刻 / 今年 = 月日 / それ以前 = 年月日）をそのまま使い、相対表記は持たない。件数と最終保存・最終使用は 1 行のチップとして並べ、文の連結で増えた時に備えて行を `flex-wrap` で折り返す
- `lastUsedAt` は会話の最終更新（作成・設定変更・送信・停止・ランの開始/再開）で、provider への API 呼び出し成功を意味しない。設定変更だけでも更新されるため、厳密な課金確認には使えない
- セッション一覧の state は `[]` 初期値のため、`useSessions` の `sessionsLoaded`（初回の取得に成功するまで false）が true になるまで「最終使用」の行を出さない。false を「会話 0 件」と混同しない。取得に失敗しても false へ戻さず、前回の一覧と状態を保つ
- セッションを削除すると集計からも消える（最終使用を永続化しない割り切り）。一覧に出ない会話（ストア移行・meta 破損など）は母数に入らない

## 応答契約

| 結果 | HTTP | body `state` | 意味 |
| --- | --- | --- | --- |
| DB 保存 + SDK 反映まで成功（モデル選択・メモは DB 保存だけ） | 200 | `applied` | 完了 |
| DB 保存済み・SDK 反映が未完了 | 200 | `applied_unsynced` | キーは永続化された。反映は resync / 次回変更 / 再起動で行う |
| DB 保存に失敗（何も変わっていない） | 503 | `not_stored` | 変更は適用されていない |
| 入力・対象が不正 | 400 | — | 変更なし |
| ランタイムが利用不可（pi null） | 503 | `not_stored` | 変更なし（カタログ検証ができない） |

`applied_unsynced` は「永続化は確定した」ので 2xx とする（成功と失敗の混在を HTTP で二重表現しない）。`not_stored` は DB の**単一ステートメント（自動コミット）が commit されなかった**場合だけに使い、DB 書込後に DTO の組み立てや state の再計算が失敗した場合は `applied_unsynced` として degraded を残す。利用可能なモデルの保存だけは SDK 呼び出しを持たないため `applied` だけを返す（DTO を組めないときも、保存が確定していれば `applied` として次の GET に追随させる）。GET は `state` を持たない純粋読取で、SDK 呼び出しも修復も行わない。

このとき一覧を読めずに rows を空で組むフォールバックでも、`managed` は**行があると確定している操作（PUT / resync apply）だけ**に付け、DELETE のフォールバックでは対象を `managed: true` にしない（`managed` = DB 行の契約を守り、削除できた行に [削除] を残して再削除を 400 にしない）。メモの保存も SDK 呼び出しを含まないため `applied` だけを返し、DTO を組めないときは `#compose([], [], selection)` 相当の縮退で `applied` を返して次の GET に追随させる（この経路では `managed` / `memo` が一時的に欠けうる）。

## 手順と並行性

認証変更・利用可能なモデルの保存・DB 書込・state 公開は**同じサービスインスタンスの 1 本のミューテーションロック**で直列化する。ロックの内側で:

1. 検証（対象 provider / `canSetApiKey` / 長さ 8..2048 / カタログ内か / ランタイムの可用性）
2. 入力キーを**マスカーへ登録**（SDK / DB より前。同期 swap）
3. DB 書込（失敗したら 503 `not_stored`）
4. `applyApiKey` / `removeApiKey`（SDK commit）。`applied/synced` でなければ同じ操作を 1 回だけ再試行する（冪等）
5. `refreshModelState()` を 1 回（成功・失敗のどちらでも）。可用 0 の安全な state へ寄せ、例外を出さない
6. `applied` なら degraded を解除、そうでなければ `apply` / `remove` として記録して応答を組む

利用可能なモデルの保存は 1 → 3 → `setModelSelection()` → 5 の順で、SDK commit（4）と degraded（6）を持たない。メモの保存は「対象 provider の存在確認（カタログ / credential 行 / メモ行のいずれか。無ければ 400）」→ 3 の順で、`refreshModelState()` も health / カタログの再取得も行わない。応答は「自分の変更までを含む state」を公開し、別 provider の同時 PUT も 1 件ずつ直列化される。1 回の例外（lock の rejected Promise）で後続の変更が止まらない。

- `CredentialCommit` の写像: SDK の `CredentialSynchronizationError` は Map への commit 後に同期が失敗した印なので、`providerId` と `operation` が一致するときだけ `applied/synced: false` とする。開始前と確実に識別できる abort（呼び出し時に signal が abort 済み）は `not_applied`、timeout・実行中 abort・未知の例外は `unknown` として**未適用と断定しない**。`credential` / `cause` / 生の例外文言は応答・health・ログへ流さない

### resync

`POST /api/settings/models/:provider/resync` は degraded の回復操作で、DB の希望状態を SDK へ再適用するだけ（冪等）。対象は**カタログに存在する provider** か **degraded が `remove` の provider** に限り、それ以外は 400 にする（UI 外で張られた runtime overlay を消さないため）。degraded でない provider への呼び出しも 200 になる。

## 起動時の適用

`bootstrap.ts` は `createPiBff()` → `AppDb.open({ storeDir, sanitizeError })` → `applyStored()` → `SessionStore` / `NotificationService` の順に組み立てる。DB を開く前に pi の初回 state（制限なし・既定は未設定）が立つため、`applyStored()` は listen 前に setter → `refreshModelState()` を必ず 1 回通す。

1. `readModelSettings()` を読み、`setModelSelection()` で保存値を写す。失敗したら「未設定（制限なし）」で続行し、警告だけを残す（health の `appDb` が失敗を示し、設定 API は 503 になる。この失敗は `provider_credentials` の読取成功では消えない）
2. `listProviderCredentials()`。失敗しても 1 の適用と最後の再計算は行う（警告のみ。空 DB として黙って続行はしない）
3. **全行のキーをマスカーへ登録**（SDK へ渡す前。orphan・不正値・適用失敗でも保持）
4. 行ごとに `applyApiKey`（+ 0〜1 回の再試行）。失敗は `degraded: "apply"` として記録し、ログには provider id と分類だけを残す
   - カタログに無い provider（orphan）と 8 文字未満の行は SDK へ渡さず、`degraded: "apply"` だけ記録する（GET の削除導線）
5. 最後に `refreshModelState()` を 1 回

`degraded` はこのプロセスのメモリだけが持つ（再起動で消える）。GET はカタログの provider、`provider_credentials` 行、`provider_memos` 行、degraded の和集合を返し、DB 行にしか無い provider は `orphan: true` / `canSetApiKey: false` / `managed: true` として削除導線を出し、メモ行にしか無い provider は `managed: false` / `orphan: true` として出す。`#settingOf` の degraded 自動付与（orphan → `apply`）は credential 行がある（`appliable`）provider だけに限り、メモだけの orphan に「保存済み（未反映）」と [再同期] を出さない。

## 秘密マスク

- UI 入力のキーは **SDK / DB に触る前**に `retainSecret()` でマスカーへ登録する。`createMutableSecretMasker` の swap は同期の 1 参照差し替えで、`SessionStore` / `NotificationService` / ツール closure / streaming masker の既存参照へそのまま効く
- 登録済みのキーは削除・上書き後も**プロセス生存中は保護対象から外さない**。`session.jsonl` は raw の入力を持ち、表示のたびに現在のマスカーで再投影するため、削除は「今後の認証に使わない」であって「過去の値を開示してよい」ではない（[secrets.md](secrets.md)）
- キーは GET 系 API の応答に一切含めない。入力の長さは 8..2048 文字で、これより短いキーしか受け付けない keyless / ローカル provider は環境変数や `models.json` の領域として GUI の対象外にする
- `AppDb.open({ storeDir, sanitizeError })` で `#query` と `open()` のログ・`#error`（health / 503 に載る）をマスカーで境界化する。`bootstrap.ts` は可変マスカーを渡し、後から登録されたキーにも効かせる
- メモは秘密情報ではないので `retainSecret()` に渡さない。任意の自由文を登録すると、短いメモでも `createMutableSecretMasker` が値をマスクし、よくある単語が会話表示で赤塗りされる誤爆の方が実害より大きい。代わりに、ログ・health・エラー文言のどの経路にも値を載せない

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/models` | 保存値（`allowedModels` / `defaultModel` / `ignoredEnvironmentVariables`）と provider 一覧（auth 状態・managed・keyUpdatedAt・degraded・orphan）。純粋読取 |
| PUT | `/api/settings/models/allowed` | 利用可能なモデルとアプリ既定モデルの一括保存。両方 `null` が未設定へ戻す |
| PUT | `/api/settings/models/:provider/key` | APIキーを登録（既存は上書き） |
| PUT | `/api/settings/models/:provider/memo` | provider のメモを保存（`trim` して空なら行を削除）。上限 500 文字 |
| DELETE | `/api/settings/models/:provider/key` | この画面で登録したキーを削除（行が無ければ 400） |
| POST | `/api/settings/models/:provider/resync` | degraded の回復。body 無し |

`canSetApiKey` は SDK の `auth.apiKey.login` の有無で判定する（ambient / keyless provider は login を持たない）。詳細な DTO と応答は [api.md](api.md#利用可能なモデルとプロバイダーapiキー設定--モデル)。

## クライアント

- 画面は `/settings/models`（モデルを選ぶ。既定）、`/settings/models/providers`（プロバイダー）、`/settings/models/images`（画像生成）、`/settings/models/web-search`（Web 検索）の 4 タブ。タブの語彙は `client/src/lib/settingsNav.ts` の `MODELS_SUBSECTIONS` に置き、URL と `routePath` が同じ値を使う。未知のサブセクションと `/settings/models/models` は既定タブヘ畳む（モデル画面からチャットへ飛ばさない）。タブ行は `SettingsPageLayout` の任意スロットに置き、`ProjectDialog` と同じ `.tab-item` を使う
- `useModelSettings` / `useImageSettings` / `useWebSearchSettings` は 4 タブの親（`ModelSettingsPage`）で 1 回ずつ呼び、モデル側の未保存の下書き（モデルの選択・既定モデルと、provider ごとの apiKey / メモ）も親が持つ。タブ切替・provider 切替・検索で再マウントしても下書き・note・カタログを失わない。カタログと設定は独立に取り、片方の失敗で他方を捨てない。ヘッダの [再読み込み] は 3 hook の分を更新し、注記と無効化は表示中のタブのものだけを出す。取得中フラグは破棄された要求の完了でも解除する（`createLoadingTracker()`。解除を応答の適用可否で分岐すると、変更操作と重なったときに再読み込みボタンが無効のまま残る）
- 「モデルを選ぶ」タブは、候補を「認証済み provider のカタログ全件」と「カタログ外の残存エントリ」の和集合で組む。認証が設定されていない provider の選択は行に出さず、下書きからも落として保存しない（`pruneAvailabilityDraft()`）。カタログ外の残存だけは保存が 400 になるため、認証が無くても警告付きで出して外せる。折りたたみ中は行を描画せず、既定は全部閉じる（検索中の該当 provider と、警告のある provider だけ開く）。検索は DOM ではなくカタログのデータ（provider / モデル名 / ID）に当てて該当 provider を自動展開し、「選択済みのみ」でチェック済みだけに絞る
  - provider 行はバッジと `利用可能 a/b ・ 選択 c`（a/b はカタログ、c は下書き全体の選択数）を出し、[すべて選択] は認証済み provider だけ、[すべて解除] はカタログに無い provider でも保存済みを外せる。provider 群はカタログ順（「プロバイダー」タブと同じ）で表示する。これは表示順の説明だけで、保存値と既定モデルの解決には関係しない（未設定でもアプリが `getAvailable()` の先頭を既定にすることはない）
  - 未認証の provider はカタログ外の残存があるときだけ警告付きで出し（カタログ全件は出さない）、外せる（`allowedModelsOutsideCatalog()` 相当の判定を `candidateGroups()` が行と警告に写し、認証が無い provider のカタログ内の選択は行に出さない）。選択 0 件は固定バーで保存を無効にし、理由として「空の選択は API で「制限なし（全モデル）」へ正規化されるため、この画面からは送らない」を示す
  - アプリ既定モデルは `ModelDefaultPicker`（native popover + listbox。`composer/AgentPicker.tsx` と同じ組み方）で選び、先頭に「未設定」を残す。選択が 0 件のときは選べない理由をピッカーの下に出す。行は名前と ID を分け、検索は名前 / ID に当てる
  - 保存は本文の外に固定した下部バーにまとめ、変更がなければ [モデル候補を保存] を無効にし、差分があれば [変更を破棄] / [モデル候補を保存] を出す。保存で利用可能なモデルが 0 件になるときと既定が未認証のときは、純関数の文言で画面内の確認（[保存する] / [キャンセル]）を出し、後者は保存前から警告を出す（固定バーの中で完結させ、共通の確認ダイアログは使わない。判定は `availabilitySaveOnSubmit()` の純関数で固定し、同意するまで PUT を送らない）。成功時は応答値から下書きを作り直す。設定 API の保存値が実際に変わった場合も下書きを戻すが、配列参照だけが変わって内容が同じ場合は編集中の下書きを保つ。カタログの更新（キー操作での再取得・再取得の失敗で `catalog: null` になる場合）だけでは下書きを置換しない（`availabilityDraftState()` が保存値の変更と、カタログ無しで作った初期値の初回カタログ到着だけを作り直しの条件にし、認証が外れた provider の選択は `pruneAvailabilityDraft()` で下書きと比較基準から落とす）
  - 選択の正は `GET /api/settings/models` の `allowedModels` だけで、カタログは available と候補の表示にしか使わない。カタログを取得できないときは `catalogError` で編集不可を出し、プロバイダータブのキー操作は妨げない（`catalog === null` は初期ロード中も真になるため、編集可否の判定には使わない）
  - 保存後は health とカタログを取り直して、入力欄のモデル候補を追随させる。live の会話のモデルを切り替えないことを画面に注記する（[model-effort.md](model-effort.md#既存の会話への影響認証の変更)）
- 「プロバイダー」タブは左の一覧（`GET /api/settings/models` の全件を「設定済み（`auth.configured` / `managed` / メモあり / 利用可能モデルあり）」と「未設定」に分け、検索は provider 名 / ID。件数メタは `available/catalog` または未反映・カタログ外）と右の詳細（APIキーの登録・上書き、メモ、削除、再同期、利用可能数、`degraded` の案内）の master-detail。詳細の上部にキーの平文保存と「BFF を LAN / インターネットへ公開しない」注意を常時出し、プロバイダーを切り替えても消さない。キー保存後に「モデルを選ぶ」タブへ戻る導線を置き、固定バーではキー・メモが各保存ボタンで即時保存されることを区別する。モデル一覧の重複表示（旧 ModelTable）は削除した
  - 詳細は認証バッジ（未設定 / 環境変数（変数名）/ 保存済み（auth.json）/ この画面で登録済み（実効）/ 保存済み（未反映）/ 削除が未反映 / カタログ外）を出し、`canSetApiKey` のときだけキー入力、`managed` のときだけ削除（確認に既存会話への影響を出す）、再同期可能な `degraded` のときだけ再同期を出す。キー最終保存は `managed` の provider だけに「保存日不明」を含めて出す
  - 見出しの 1 行メタ（`利用可能 a / カタログ b`・`キー最終保存: …`・`最終使用: …`）は、認証バッジと同じ寸法のチップ（`client/src/components/model-settings/MetaChip.tsx`）で組む。チップの色は警告の有無にだけ使い、日時や件数の値では変えない（情報の種別ではなく、対処が要るかを見せる）
  - 未反映の案内文（`degradedNotice`）は、その詳細で実際に押せる回復操作に合わせる。カタログ外（`orphan`）の `apply` は resync API も 400 にするため [再同期] を案内せず、[削除] とカタログ復帰を案内する
- メモ欄はキー入力とは別の `<form>` にした `<textarea rows={2} maxLength={500}>` と [メモを保存] で、Enter がキーの保存を走らせない。入力値は `provider.memo` が変わったときだけ同期し、dirty（`trim` 後の値が保存値と違う）のときだけ保存を有効にし、未保存の印を出す。保存に成功したら応答の `trim` 済みの値で入力値を戻す。メモの保存は SDK に触れないので health / カタログを取り直さず、進行中の `reload()` の応答で保存直後を上書きされないよう先行ロードの無効化だけ行う。`runtimeAvailable: false` のときは入力欄と保存を disable し、runtime 停止時の注意書きにメモも含める。カタログ外のメモだけの provider には「キーの登録はできません（メモは保存できます）」と案内し、キー入力は出さない
- 「画像生成」タブは画像専用の APIキー・モデルだけを扱い、上部に provider（v1 は OpenRouter）の見出し（ロゴ・表示名・id・キーの登録状態）を出し、`settings.provider` に追随してロゴが切り替わる。未設定ではキー入力だけを出す（キー保存で行ができてからモデル選択と削除が現れる）。キーは常に空の入力欄へ再表示し、本物のキーは GET 応答にも載せない。`runtimeAvailable: false` のときはキー登録・上書き・削除を disable する（モデルの変更は SDK に触れないため残す）。操作と注意書きの詳細は [image-generation.md](image-generation.md#設定画面画像生成タブ)
- APIキーの登録後は health と `GET /api/runtime/models` を取り直し、入力欄のモデル候補とモデル数を追随させる。カタログの取得失敗は設定 API の表示を壊さず、両タブで別の注記として出す
- 8 文字未満は保存前に同じ理由で止める（サーバーも 400）。モデルの選択・既定で使う語彙は「利用可能（available）」と「選択」の 2 語に統一する

## 既存の会話への影響

**既存の live セッションのモデルは自動で切り替えない**。ただし影響はある。

- キーを削除した provider を使っている会話は、**次回の送信が認証で失敗する**ことがある（環境変数や `auth.json` の認証があればそちらが使われる）
- 利用可能なモデルから外したモデルを使っている会話も、**次回の送信はそのモデルのまま行われる**（送信は拒否しない）。未ロードの会話は復元時に保存モデルを候補と照合し、候補が無ければアプリ既定へフォールバックする（[model-effort.md](model-effort.md#復元時の解決)）。フォールバックした実効値は `model_change` へ追記される
- `applied_unsynced` の間は availability が古いまま公開 state に残りうる。送信自体は実際の認証に従うため、選択中モデルの送信が失敗する可能性がある（画面に警告を出す）

## 環境変数からの移行

1. 設定 → モデルで既存と同じキーを登録し、再起動後も使えることを確認する
2. 設定 → モデル の「利用可能なモデル」で、`PI_MODELS` に入れていた一覧と同じモデルを選び、既定モデルも `PI_MODEL` と同じものを選んで保存する（`PI_MODEL` の `:low` などの Effort サフィックスは `PI_THINKING` へ移す）
3. デプロイ設定（`.env` / マニフェスト / シェル）から `PI_MODELS` / `PI_MODEL` / `PI_PROVIDER` の行を削除する。残すと起動ログと画面（`ignoredEnvironmentVariables`）に警告が出続ける
4. 確認できたら、サーバーの `.env` からそのキーの行も消す（`PI_APP_CWD` / `PI_SESSION_STORE` など他の設定に `.env` を使っているなら、ファイル自体は消さない）
5. シェル環境変数やデプロイ設定に残ったキーも同様に見直す（BFF は起動時に環境変数を読み、GUI の登録値は runtime overlay として環境より優先される）

## 残存リスク

- DB は平文。WAL・バックアップ・ボリュームの読み取り権限を持つ者はキーを読める。ファイルのアクセス権を管理し、**ログイン認証のない BFF をインターネットや LAN へ公開しない**。保存時暗号化は別スコープ
- 削除・上書きした旧キーはプロセス生存中のみ保護される。再起動後、チャットへ貼り付けた生の入力（`session.jsonl` に raw で残る）が再投影で見える可能性がある。恒久対策（tombstone の保持）は将来課題
- キーの有効性は保存時に検証しない（プロバイダーへの実リクエストを送らない）
- カタログ外の残存エントリがある間は利用可能なモデルを保存できない（400）。画面に削除導線は出すが 1 手間残る
- 環境変数の警告は表示だけで自動移行しない
- DB を読めないときは制限が外れた状態（制限なし）で起動する。気付けるのは起動ログの警告・health の `appDb`・設定 API の 503 に限る
- `PI_SECRET_ENV_VARS` は環境変数名の指定なので、GUI 登録のキーには不要
- メモは平文で DB に入り、GET 応答にも平文で載る（ログインの無い BFF は LAN 越しに読める）。画面の注意書きと placeholder でキー本体を書かないよう誘導するが、短いメモでも会話表示のマスクは掛からない
- OAuth のブラウザログイン、`models.json` のカスタム provider / baseUrl の編集、既定 Effort（`PI_THINKING`）の GUI 化、プロジェクト / エージェント単位のモデル制限は対象外

## 検証

実 API は呼ばず、ダミーキーと fake / stub で検証する。

- `server/test/app-db.test.ts` — v4 → v5 / v5 → v6 / v6 → v7 の加算移行、`model_settings` の CRUD、空配列 = 制限なしの正規化、両方 NULL の行削除、壊れた JSON の 503、`provider_memos` の CRUD（上書き・削除・空文字行 = 未設定）、`provider_credentials.updatedAt` の移行（既存行は NULL のまま・キーは消えない）と再実行の冪等性、新規 DB の列、`sanitizeError` の境界
- `server/test/model-settings.test.ts` — GET / PUT / DELETE / resync の契約、DB-first、1 回だけの再試行、degraded の解除と記録と DTO を組めないときの `managed` の補正、利用可能なモデルの正規化・検証（カタログ外・既定が選択外・形式・重複）と 503、メモの `trim`・空で削除・対象外 400・DB 失敗 503・メモ値を応答とログへ出さないこと・degraded を作らないこと、GET の 4 経路（カタログ / credential 行 / メモ行 / degraded）とメモだけの orphan の扱い、キー削除後もメモが残ること、`keyUpdatedAt` が GET / PUT に載り移行前は null で resync / 削除では変わらないこと、起動適用（model_settings と provider_credentials の独立した読取・setter → refresh の順序・マスク登録の順序）、別 provider の並行 PUT の直列化、lock の rejected Promise、キー値を含む例外が応答とログへ漏れないこと
- `server/test/model-settings-api.test.ts` — HTTP 契約（200 `applied` / `applied_unsynced`、503 `not_stored`、400）、メモの 200 / 400（500 文字超は route の zod）/ 503 と再起動後の読み出し、再起動後の適用、DB 不通、health とログのマスク、`ignoredEnvironmentVariables`、`keyUpdatedAt` が GET / PUT に載ることと移行前の行が null になること
- `server/test/provider-key-runtime.test.ts` — `CredentialCommit` の写像（CSE の照合・開始前 abort・実行中 abort・未知の例外）
- `server/test/model-state.test.ts` — `deriveModelState` / `readModelState`（選択リストの積・既定モデル・カタログの導出・可用 0・失敗時の安全な state）、`filterModelsByWhitelist()`
- `server/test/api.test.ts` — health から `runtimeDiagnostics` が消えたこと、モデルカタログ応答に whitelist 系フィールドが無いこと
- `server/test/redact.test.ts` — `createMutableSecretMasker` の swap と streaming masker への追随
- `client/test/modelSettings.test.ts` / `client/test/modelSettingsPage.test.ts` — 表示変換（認証バッジ・並び・入力検証・メモの検証・注記・回復案内）、`providerUsage()`（最初の `/` での分割・`model` 無し・複数セッション・空配列）、`null` の明示リスト展開（利用可能な全モデル + 既定モデルの 1 件追加）・認証済み provider の絞り込み（`pruneAvailabilityDraft()` の除去と、表示の対象を揃える `candidateGroups()` の絞り込み）・カタログ外の残存エントリの警告付き表示・候補の並び/検索/集計・既定モデルの選択肢と検索・dirty 判定・provider 一括操作・確認文、タブと保存バーの初期描画（折りたたみの既定閉・警告のある provider の自動展開・変更なしと選択 0 件では保存無効）とカタログ外・未設定・環境変数の注記・カタログ取得失敗時の編集不可、プロバイダータブの一覧と詳細（平文注意の常時表示・メモ欄・保存ボタン・runtime 停止時の disable・メモだけの orphan の案内）、キー最終保存（managed だけ・NULL は保存日不明）と最終使用（`sessionsLoaded` が false なら非表示・会話 0 件の managed は「会話はありません」・非 managed は会話があるときだけ）、`client/test/route.test.ts` のタブの正準化（未知のサブセクションと既定タブの明示は `/settings/models` へ）
- `client/test/imageSettings.test.ts` / `client/test/imageSettingsTab.test.ts` / `client/test/settingsNav.test.ts` — 画像モデルの選択肢（カタログ順・同名への id 添え・カタログ外の現在値）、現在値と PUT の本文の解決、キー入力の後始末（成功時だけ消す）、削除の確認文、タブ見出しの provider（ロゴ・未設定でも OpenRouter・ロゴの無い provider は頭文字）と provider の id / 表示名、画像生成タブの初期描画（未設定はキーのみ / 設定済みは上書き保存・削除・モデル選択 / 保存済みキーを入力欄へ戻さない / runtime 不可の disable）、4 タブの語彙
- `client/test/requestGate.test.ts` — 応答の適用可否（`createRequestGate`）、要求の追跡（`createRequestTracker`）、取得中フラグの解除（`createLoadingTracker`: 破棄された要求の完了で解除し、後続が在る間は維持する）
- `client/test/runtimePage.test.ts` — 設定 → ランタイムから「モデル解決」が消えたこと
