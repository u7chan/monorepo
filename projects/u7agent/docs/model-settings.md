# プロバイダーAPIキーの登録（設定 → モデル）

設定 → モデルから、プロバイダーごとのAPIキーを GUI で登録・削除する。登録したキーはアプリデータの SQLite に保存され（再起動後も残る）、SDK の非永続の runtime overlay へ写して起動中のモデル候補へ反映する。`.env` の環境変数と `~/.pi/agent/auth.json` はこれまでどおり使え、GUI はそれらを変更しない。

- 保存の正は **アプリ DB**（`provider_credentials`）。SDK の runtime overlay は実効状態で、再起動で消える
- 変更系の API は「DB を希望状態として先に確定」し、SDK への反映に失敗しても DB を戻さない（補償ロールバックを持たない）
- 反映できなかった変更は **degraded（保存済み・未反映）** として画面に出し、`resync` / 次回の変更 / 再起動で収束させる

## 画面の分離

| 画面 | 役割 | 内容 |
| --- | --- | --- |
| 設定 → ランタイム（表示専用） | 環境診断 | 接続状態 / 実行環境 / 利用可能なコマンド / モデル解決診断（`PI_MODEL` / `PI_MODELS`） |
| 設定 → モデル（編集可） | プロバイダー認証 + カタログ | provider ごとの認証状態、APIキーの登録・上書き・削除、再同期、利用可能モデル数とモデル一覧 |

プロバイダーとカタログの表示はランタイム画面からモデル画面へ移した。ランタイム画面は `GET /api/runtime/models` を呼ばない。

## 保存先とスキーマ

`PI_SESSION_STORE/u7agent.db` の `provider_credentials`（`APP_DB_SCHEMA_VERSION` 3 → 4）。

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  apiKey   TEXT NOT NULL
);
```

- 値は必ずバインドして渡す。保存行は**平文**で、Webhook URL と同じトラストレベル（[persistence.md](persistence.md#アプリデータsqlite)）
- `managed`（DB 行 = 永続化された希望状態）と `auth.source`（SDK の実効値。`runtime` / `environment` / `stored` …）は**別物**として画面に出す
- DB の読み書きとスキーマ移行の失敗は [persistence.md](persistence.md#失敗時の扱い) と同じで、health の `appDb` と 503 に出る

## 応答契約

| 結果 | HTTP | body `state` | 意味 |
| --- | --- | --- | --- |
| DB 保存 + SDK 反映まで成功 | 200 | `applied` | 完了 |
| DB 保存済み・SDK 反映が未完了 | 200 | `applied_unsynced` | キーは永続化された。反映は resync / 次回変更 / 再起動で行う |
| DB 保存に失敗（何も変わっていない） | 503 | `not_stored` | 変更は適用されていない |
| 入力・対象が不正 | 400 | — | 変更なし |
| ランタイムが利用不可（pi null） | 503 | `not_stored` | 変更なし |

`applied_unsynced` は「永続化は確定した」ので 2xx とする（成功と失敗の混在を HTTP で二重表現しない）。`not_stored` は DB の**単一ステートメント（自動コミット）が commit されなかった**場合だけに使い、DB 書込後に DTO の組み立てや state の再計算が失敗した場合は `applied_unsynced` として degraded を残す。GET は `state` を持たない純粋読取で、SDK 呼び出しも修復も行わない。

このとき一覧を読めずに rows を空で組むフォールバックでも、`managed` は**行があると確定している操作（PUT / resync apply）だけ**に付け、DELETE のフォールバックでは対象を `managed: true` にしない（`managed` = DB 行の契約を守り、削除できた行に [削除] を残して再削除を 400 にしない）。

## 手順と並行性

認証変更・DB 書込・state 公開は**同じサービスインスタンスの 1 本のミューテーションロック**で直列化する。ロックの内側で:

1. 検証（対象 provider / `canSetApiKey` / 長さ 8..2048 / ランタイムの可用性）
2. 入力キーを**マスカーへ登録**（SDK / DB より前。同期 swap）
3. DB 書込（失敗したら 503 `not_stored`）
4. `applyApiKey` / `removeApiKey`（SDK commit）。`applied/synced` でなければ同じ操作を 1 回だけ再試行する（冪等）
5. `refreshModelState()` を 1 回（成功・失敗のどちらでも）。可用 0 の安全な state へ寄せ、例外を出さない
6. `applied` なら degraded を解除、そうでなければ `apply` / `remove` として記録して応答を組む

- 応答は「自分の変更までを含む state」を公開する。別 provider の同時 PUT も 1 件ずつ直列化される
- 1 回の例外（lock の rejected Promise）で後続の変更が止まらない
- `CredentialCommit` の写像: SDK の `CredentialSynchronizationError` は Map への commit 後に同期が失敗した印なので、`providerId` と `operation` が一致するときだけ `applied/synced: false` とする。開始前と確実に識別できる abort（呼び出し時に signal が abort 済み）は `not_applied`、timeout・実行中 abort・未知の例外は `unknown` として**未適用と断定しない**。`credential` / `cause` / 生の例外文言は応答・health・ログへ流さない

### resync

`POST /api/settings/models/:provider/resync` は degraded の回復操作で、DB の希望状態を SDK へ再適用するだけ（冪等）。対象は**カタログに存在する provider** か **degraded が `remove` の provider** に限り、それ以外は 400 にする（UI 外で張られた runtime overlay を消さないため）。degraded でない provider への呼び出しも 200 になる。

## 起動時の適用

`bootstrap.ts` は `createPiBff()` → `AppDb.open({ storeDir, sanitizeError })` → `applyStored()` → `SessionStore` / `NotificationService` の順に組み立てる。

1. `listProviderCredentials()`。失敗したら空 DB として黙って続行しない（警告だけ出し、health の `appDb` は失敗、設定 API は 503）
2. **全行のキーをマスカーへ登録**（SDK へ渡す前。orphan・不正値・適用失敗でも保持）
3. 行ごとに `applyApiKey`（+ 0〜1 回の再試行）。失敗は `degraded: "apply"` として記録し、ログには provider id と分類だけを残す
   - カタログに無い provider（orphan）と 8 文字未満の行は SDK へ渡さず、`degraded: "apply"` だけ記録する（GET の削除導線）
4. 最後に `refreshModelState()` を 1 回

`degraded` はこのプロセスのメモリだけが持つ（再起動で消える）。GET はカタログの provider、DB 行、degraded の和集合を返し、DB 行にしか無い provider は `orphan: true` / `canSetApiKey: false` / `managed: true` として削除導線を出す。

## 秘密マスク

- UI 入力のキーは **SDK / DB に触る前**に `retainSecret()` でマスカーへ登録する。`createMutableSecretMasker` の swap は同期の 1 参照差し替えで、`SessionStore` / `NotificationService` / ツール closure / streaming masker の既存参照へそのまま効く
- 登録済みのキーは削除・上書き後も**プロセス生存中は保護対象から外さない**。`session.jsonl` は raw の入力を持ち、表示のたびに現在のマスカーで再投影するため、削除は「今後の認証に使わない」であって「過去の値を開示してよい」ではない（[secrets.md](secrets.md)）
- キーは GET 系 API の応答に一切含めない。入力の長さは 8..2048 文字で、これより短いキーしか受け付けない keyless / ローカル provider は環境変数や `models.json` の領域として GUI の対象外にする
- `AppDb.open({ storeDir, sanitizeError })` で `#query` と `open()` のログ・`#error`（health / 503 に載る）をマスカーで境界化する。`bootstrap.ts` は可変マスカーを渡し、後から登録されたキーにも効かせる

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/models` | provider 一覧（auth 状態・managed・degraded・orphan）。純粋読取 |
| PUT | `/api/settings/models/:provider/key` | APIキーを登録（既存は上書き） |
| DELETE | `/api/settings/models/:provider/key` | この画面で登録したキーを削除（行が無ければ 400） |
| POST | `/api/settings/models/:provider/resync` | degraded の回復。body 無し |

`canSetApiKey` は SDK の `auth.apiKey.login` の有無で判定する（ambient / keyless provider は login を持たない）。詳細な DTO と応答は [api.md](api.md#プロバイダーapiキー設定--モデル)。

## クライアント

- `SETTINGS_SECTIONS` に `models`（ラベル「モデル」）を追加し、`App.tsx` が `ModelSettingsPage` を出す
- 画面は provider を「設定済み（`auth.configured` / `managed` / 利用可能モデルあり）」と「未設定」に分け、未設定は畳む。各カードに認証バッジ（未設定 / 環境変数（変数名）/ 保存済み（auth.json）/ この画面で登録済み（実効）/ 保存済み（未反映）/ 削除が未反映 / カタログ外）と、`canSetApiKey` のときだけキー入力、`managed` のときだけ削除（確認に既存会話への影響を出す）、再同期可能な `degraded` のときだけ再同期を出す
- 未反映の案内文（`degradedNotice`）は、そのカードで実際に押せる回復操作に合わせる。カタログ外（`orphan`）の `apply` は resync API も 400 にするため [再同期] を案内せず、[削除] とカタログ復帰を案内する
- APIキーの登録後は health と `GET /api/runtime/models` を取り直し、入力欄のモデル候補とモデル数を追随させる。カタログの取得失敗は設定 API の表示を壊さず、別の注記として出す
- 8 文字未満は保存前に同じ理由で止める（サーバーも 400）

## 既存の会話への影響

**既存の live セッションのモデルは自動で切り替えない**。ただし影響はある。

- キーを削除した provider を使っている会話は、**次回の送信が認証で失敗する**ことがある（環境変数や `auth.json` の認証があればそちらが使われる）
- 未ロードの会話は復元時に保存モデルを候補と照合し、候補が無ければアプリ既定へフォールバックする（[model-effort.md](model-effort.md#復元時の解決)）。フォールバックした実効値は `model_change` へ追記される
- `applied_unsynced` の間は availability が古いまま公開 state に残りうる。送信自体は実際の認証に従うため、選択中モデルの送信が失敗する可能性がある（画面に警告を出す）

## 環境変数からの移行

1. 設定 → モデルで既存と同じキーを登録し、再起動後も使えることを確認する
2. 確認できたら、サーバーの `.env` からそのキーの行を消す（`PI_APP_CWD` / `PI_SESSION_STORE` など他の設定に `.env` を使っているなら、ファイル自体は消さない）
3. シェル環境変数やデプロイ設定に残ったキーも同様に見直す（BFF は起動時に環境変数を読み、GUI の登録値は runtime overlay として環境より優先される）

## 残存リスク

- DB は平文。WAL・バックアップ・ボリュームの読み取り権限を持つ者はキーを読める。ファイルのアクセス権を管理し、**ログイン認証のない BFF をインターネットや LAN へ公開しない**。保存時暗号化は別スコープ
- 削除・上書きした旧キーはプロセス生存中のみ保護される。再起動後、チャットへ貼り付けた生の入力（`session.jsonl` に raw で残る）が再投影で見える可能性がある。恒久対策（tombstone の保持）は将来課題
- キーの有効性は保存時に検証しない（プロバイダーへの実リクエストを送らない）
- `PI_SECRET_ENV_VARS` は環境変数名の指定なので、GUI 登録のキーには不要
- OAuth のブラウザログイン、`models.json` のカスタム provider / baseUrl の編集、既定モデル（`PI_MODEL`）/ whitelist（`PI_MODELS`）の GUI 変更は対象外

## 検証

実 API は呼ばず、ダミーキーと fake / stub で検証する。

- `server/test/model-settings.test.ts` — GET / PUT / DELETE / resync の契約、DB-first、1 回だけの再試行、degraded の解除と記録と DTO を組めないときの `managed` の補正、別 provider の並行 PUT の直列化、lock の rejected Promise、起動適用（マスク登録の順序・orphan / 短い行の除外）、キー値を含む例外が応答とログへ漏れないこと
- `server/test/model-settings-api.test.ts` — HTTP 契約（200 `applied` / `applied_unsynced`、503 `not_stored`、400）、再起動後の適用、DB 不通、health とログのマスク
- `server/test/provider-key-runtime.test.ts` — `CredentialCommit` の写像（CSE の照合・開始前 abort・実行中 abort・未知の例外）
- `server/test/model-state.test.ts` — `deriveModelState` / `readModelState`（whitelist、既定モデル、可用 0、失敗時の安全な state）
- `server/test/app-db.test.ts` — v3 → v4 の加算移行、CRUD、`sanitizeError` の境界
- `server/test/redact.test.ts` — `createMutableSecretMasker` の swap と streaming masker への追随
- `client/test/modelSettings.test.ts` / `client/test/modelSettingsPage.test.ts` — 表示変換（認証バッジ・並び・入力検証・注記・回復案内）と初期描画（カタログ外の未反映行に再同期ボタンを出さないこと）
