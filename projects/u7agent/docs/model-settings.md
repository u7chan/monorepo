# 利用可能なモデルとプロバイダーAPIキーの設定

設定 → モデル（`/settings/models`）から、**モデル候補（選択リスト）**・**アプリ既定モデル**・**プロバイダーごとのAPIキーとメモ**を GUI で設定する。保存した内容はアプリデータの SQLite に残り（再起動後も使え）、SDK の非永続の runtime overlay と公開 state へ写して起動中のモデル候補へ反映する。プロバイダーの認証に `.env` の環境変数と `~/.pi/agent/auth.json` を使う経路はこれまでどおり使え、GUI はそれらを変更しない。

- 保存の正は **アプリ DB**（`provider_credentials` / `model_settings` / `provider_memos`）。SDK の runtime overlay は実効状態で、再起動で消える
- APIキーの変更系は「DB を希望状態として先に確定」し、SDK への反映に失敗しても DB を戻さない（補償ロールバックを持たない）。反映できなかった変更は **degraded（保存済み・未反映）** として画面に出し、`resync` / 次回の変更 / 再起動で収束させる
- 利用可能なモデルとアプリ既定モデルは SDK 呼び出しを含まないため degraded を作らない。「DB 確定 → 公開 state の再計算」だけで効く
- provider メモはキーの登録有無と独立した人間用の任意文字列で、SDK 呼び出しを含まない。`applied` だけを返し、キーを削除しても残る

## 画面の分離

| 画面 | 役割 | 内容 |
| --- | --- | --- |
| 設定 → ランタイム（表示専用）。サービス（既定、`/settings/runtime`）/ 環境（`/settings/runtime/environment`）/ 診断（`/settings/runtime/diagnostics`）の 3 タブ | 公開サービスの操作と環境診断 | サービス: 公開中のサービスの確認・停止。環境: 接続状態 / 実行環境 / 利用可能なコマンド / SDK バージョン。診断: セッション診断 |
| 設定 → モデル（編集可） | モデルを選ぶ（`/settings/models`。既定）/ プロバイダー（`/settings/models/providers`）の 2 タブ | モデル候補の選択とアプリ既定モデル、provider ごとの認証状態、APIキーの登録・上書き・削除、メモの保存、再同期、カタログの利用可能数。モデル一覧の重複表示は持たない |
| 設定 → コンテンツ生成 | 画像（`/settings/content`）/ TTS（`/settings/content/speech`）/ BGM（`/settings/content/bgm`） | 共有APIキーと画像・TTSの選択、[BGM固定モデルの表示](bgm-generation.md)。タブの語彙の正は `client/src/lib/settingsNav.ts` |
| 設定 → Web 検索（編集可）（`/settings/web-search`） | 検索の実行時設定 | `web_search` の実行時トグル・既定 provider・provider ごとの APIキー（[web-search.md](web-search.md#実行時トグル)） |

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

## 認証ソースと優先順位

u7agent は Sign in with ChatGPT（SIWC）の資格情報を**認証ソースとして認める**。`openai` など provider の認証は Pi の通常の解決に委ね、次の優先順位で 1 つの資格情報が実効になる（詳細は [model-effort.md](model-effort.md)）。

1. **この画面で登録したキー**（`auth.source: "runtime"`）。runtime overlay で、保存の正はアプリ DB の `provider_credentials`
2. **agent dir の `auth.json` の資格情報**（`auth.source: "stored"`。既定は `~/.pi/agent/auth.json` で、置き場所は `PI_CODING_AGENT_DIR` で変わる）。`pi /login` 等で入れた SIWC を含む
3. **`models.json` のキー / コマンド**（`auth.source: "models_json_key"` / `models_json_command`）
4. **環境変数**（`auth.source: "environment"`）

`auth.json` の資格情報は**Pi 管理を正とし、アプリ DB へ複製しない**。画面は表示と警告と、この画面からの OAuth サインイン・サインアウト（[OAuth サインイン](#oauth-サインイン)）を持ち、`auth.json` の写し・優先順位・送信先の決定は SDK に委ねる。1 が 2 を覆っている間、SDK からは 2 が見えない（`ModelRuntime.listCredentials()` も overlay の `api_key` を返す）。そのため画面は SDK の公開 API から**見えている種別**だけを出し、覆われている保存値は BFF が `auth.json` を読み取り専用で見て判定する。

- 種別は `ModelRuntime.isUsingOAuth()`（SDK が見ている資格情報）から写す。runtime overlay があるときは overlay（この画面のキー = `api_key`）になり、保存値の種別は見えない
- 覆われている保存値の判定は、SDK の `readStoredCredential()` で `auth.json` を 1 件だけ読む。**表示専用**で、認証の解決・優先順位・送信先の決定には使わない。トークン・`clientId`・認可 URL は読まず、応答にもログにも載せない（種別だけを取る）
- 読取失敗・壊れた JSON・保存が無い場合は「不明」として注記を出さない（黙って縮退させる）。この読み取りは `auth.source: "runtime"` の provider にだけ行い、通常の GET で `auth.json` を開かない
- 種別の判定に認証ストアのロック（`auth.json.lock`）を取る経路は使わない。GET は同期のスナップショットを読むだけで、他のプロセスがログイン中の設定 API を待たせない

### 認証バッジの意味

詳細ペインと provider 行のバッジは、保存行の有無（`managed`）と実効の出所（`auth.source`）を混ぜない。

| バッジ | 意味 |
| --- | --- |
| 未設定 / 未設定（OAuth 可） | `auth.configured` が false。「OAuth 可」は provider が `oauth` を持つ印で、この画面でサインインできる印ではない（[OAuth サインイン](#oauth-サインイン)） |
| 環境変数（名前） | `auth.source: "environment"`。名前は `auth.environmentVariables` |
| 保存済み（auth.json）: <OAuth の表示名> | `auth.source: "stored"` で種別が `oauth`。表示名は provider の `oauth.loginLabel`（無ければ `OAuth`） |
| 保存済み（auth.json）: APIキー | `auth.source: "stored"` で種別が `api_key` |
| models.json のキー / コマンド | `auth.source: "models_json_key"` / `models_json_command` |
| この画面で登録済み（実効） | `auth.source: "runtime"`。`managed` とは別で、実効の出所だけを表す |
| 保存済み（未反映） / 削除が未反映 | このプロセスの SDK 反映が未完了（`degraded`） |
| カタログ外（保存済み） / カタログ外 | 現在のカタログに無い provider（`orphan`） |

### この画面のキーが SIWC を覆っているときの注記

`auth.source: "runtime"` かつ `auth.json` に同じ provider の OAuth があるときだけ、詳細に「この画面のキーが優先され、<OAuth の表示名> は使われていません。使うにはキーを削除してください」と出す。キーを削除すると `auth.source` は `stored` へ戻り、注記も消える。案内する操作はそのカードで実際に押せるものだけにし、削除が未反映（`degraded: "remove"`）の間は DB 行が無くて [削除] を出せず DELETE の再実行も 400 になるため、「[再同期] でキーの削除を反映してください」へ分岐する。DTO の `credentialKind` / `oauthLoginLabel` / `hiddenStoredOAuth` の 3 つだけを使い、画面は推測しない。

## OAuth サインイン

provider 詳細から Sign in with ChatGPT（SIWC）などをサインイン / サインアウトできる。SDK の公開 API（`ModelRuntime.login(provider, "oauth", interaction, { getDeviceId, agentName })` / `logout`）だけを使い、**資格情報の保存先は `auth.json` のまま**にする（アプリ DB へ複製せず、`provider_credentials` の行も触らない）。新しい依存も SDK 側の改変も足さない。

- 進行状態は BFF のメモリだけが持ち、再起動で消える。公開するのは状態・認可 URL・案内（`instructions`）・補助の進行（`progress`）・貼り付け欄・デバイスコードで、**認可 URL は進行中の間だけ**載せ、完了・失敗・キャンセルで落とす。生の例外文言・トークン・`clientId` はどのフィールドにも載せない（応答の形の正は `server/src/schema.ts` の `OAuthLoginStateSchema`）
- 進行中の表示は、デバイスコード → 承認待ち → URL 未着 の順に判定する副状態で主文を 1 つに絞り、`progress` は**主文を置き換えず**補助行として併記する（SDK の進捗だけを出すと承認の案内が消える provider がある）。`instructions` と `progress` の分業は [api.md](api.md#利用可能なモデルとプロバイダーapiキー) も参照する
- 進行中の二重開始は provider ごとに 409 にする。中断は SDK のコールバックサーバー（provider ごとの待受。`127.0.0.1` の固定ポートか一時ポート）と通信を閉じ、終端した状態は [閉じる] で消える。中断 API は冪等にし、進行中なら中断、終端なら消去にする（完了直後の [中断] を 400 にしない）。認可 URL と `manual_code` の発行前に中断が確定した場合、後着の prompt は拒否して入力欄を立てない（abort 済みの signal に listener を足してもイベントは再発火しないため、prompt の開始前に終端と abort 済みを見る）
- 完了・失敗・キャンセルで `refreshModelState()` を 1 回だけ呼び、available / health を追随させる。サインイン中はクライアントが `GET /api/settings/models` をポーリングし、終端したら health とカタログも取り直す。**成功はこの再計算が終わってから `succeeded` として公開**し、待っている間も認可 URL と入力欄は載せない（クライアントは成功を観測すると再取得を止めるため、先に公開すると未認証時の候補が残る）
- 失敗は固定の分類（コールバックポートの競合 / 承認拒否 / この画面で扱えない方式 / 不明）に寄せ、文言は `server/src/oauth-login.ts` の定数を正とする。SDK / provider の英語のメッセージは応答にもログにも出さず、ログには分類だけを残す
- この画面でサインインを完了できる provider は許可リスト（`server/src/oauth-login.ts`）で決める。SDK の flow が求める対話は静的な metadata に現れず、`select` / `text` を求める flow も開始するまで分からないため、`auth.oauth` の有無からは推測できない（許可リストに無い provider は使えない側に倒す）。対応するのは「認可 URL + 貼り付け」と「デバイスコード」の方式だけで、`select` を求める `anthropic` / `openai-codex` / `radius` と、`text` を求める `github-copilot` は入らない。イベントは `auth_url` / `device_code` / `progress` だけを写し、`info` は無視する
- 別マシンのブラウザで承認する経路（貼り付け）と、ホスト内の別のプロセスとの競合の注意は、進行中の折りたたみの中だけに置く。既定では見せず、貼り付けフォームは `input !== null`（サーバーが `manual_code` を待っている間）のときだけ出す。`input === null` のときは受け付けていないことを出し、サーバーも 400 にする。折りたたみは認可 URL があり、デバイスコード方式でないときだけ出す（デバイスコード方式はコードと承認ページをパネルに出す）。[URL をコピー] は認可 URL があるときだけ有効にし、クリップボードへ載せるのはユーザー操作のときだけにする
- 開始クリックで空タブを先に開き、認可 URL が届いたらそのタブを遷移させる（ブラウザの起動はユーザー操作起点に限られ、開始の応答を待ってから開くと popup blocker に止められる）。遷移できたときは「どこが開くか」の補足を出し、できなかったときだけフォールバックのリンクを出す（両方は出さない）。この判定は**折りたたみの有無とは独立に、認可 URL と遷移結果だけで**行う（デバイスコード方式は折りたたみを出さないため、遷移できなかったときはリンクとコピーをパネルに出す）。**自分が開いたまま遷移させていないタブ**だけを、失敗・中断・期限切れ・開始の失敗・パネルのアンマウント（provider の切替・画面の離脱）で閉じる。遷移させたタブは閉じないし、自分が開いていない別タブには触れない
- 許可リストの判定は**表示専用**にする。`GET /api/settings/models` の `providers[].canSignInHere`（任意。省略 = この画面ではサインインできない）に載せ、`POST /login` の対象判定（`supportsOAuth`）とは別に持つ。許可リストに無い provider ではサインインの操作（開始 / 進行表示 / 貼り付け / [中断]）を出さず理由に置き換え、API を直接叩いた場合は従来どおり開始を受け、扱えない対話で固定文言の失敗になる（login API は変えない）
- 進行中のサインインはコールバックの待受を開いたままにする（固定ポートの provider は `1455` を占有し、動的なポートの provider もある）。ブラウザを閉じたまま放置すると次のログイン（`pi /login` を含む）が失敗するため、開始から一定時間で自動的に中断して解放する（期限は状態遷移や進捗では延長せず、残り時間は表示しない）。待たずに終わらせたいときは [中断] するか BFF を再起動する
- サインアウトは `auth.json` の OAuth を消すだけで、provider 側の接続は失効させない（解除は ChatGPT 設定から）。SDK の `logout` は同じ provider の runtime overlay（この画面で登録したキー）も消すため、`provider_credentials` に残るキーの希望状態を公開 state の再計算前に写し直す。写し直しや復元の判断に使う DB の読取に失敗したときは既存の未反映（`degraded: "apply"`）として残し、カードの [再同期] へ導く。[サインアウト] は `auth.json` の OAuth が実効のときと、この画面のキーが覆っているとき（`hiddenStoredOAuth`）に出し、進行中は 409 にする
- `auth.json` の OAuth が消えるのは、サインアウト（この画面）と、agent dir が永続マウントされていない構成での再デプロイ（[persistence.md](persistence.md)）。どちらも復旧はサインインし直しで、この画面にサインインの操作が無い provider は同じ agent dir を使う `pi /login` だけが経路になる（[実行形態ごとの扱い](#実行形態ごとの扱い)）
- device id（agent host ID）は `<agentDir>/u7agent/device-id` に UUID を保存し、プロセスを再起動しても同じ値を `getDeviceId()` から返す。Pi の `settings.json` は共有の設定ファイルなので触らない。書けない環境ではメモリ上の値を返し、警告だけを残す（ログインは続けられる）
- 保存済みの OAuth は SDK が送信時に解決する。失効・接続解除・更新失敗は provider の認証状態や available には現れず、最初に見えるのは送信の失敗で、そのときは認証エラー（[run-lifecycle.md](run-lifecycle.md#失敗の分類と公開契約) の `oauth_expired`）として再サインインを案内する。この画面にサインインの操作が無い provider は同じ agent dir を使う `pi /login` でしか回復できないため、案内はどちらの経路も条件付きで示す

### 実行形態ごとの扱い

- ローカル（`pnpm dev`／BFF が `127.0.0.1` で待受）: GUI からそのままサインインできる。同意画面とコールバックは同じマシンのブラウザで開く
- 配布コンテナ: agent dir（`PI_CODING_AGENT_DIR`。未設定なら `$HOME/.pi/agent`）を永続マウントするかはデプロイ側の設定次第で、アプリはこの環境変数を設定しない（[persistence.md](persistence.md#現状)）。マウントしていない構成では `auth.json` が再デプロイのたびに消えるため、サインインし直しが要る
- 配布コンテナの自動コールバックは、コールバック用の固定ポート（`1455`）をデプロイ側で `127.0.0.1` へ publish していて、かつブラウザがデプロイ先のホストにある（またはホストへトンネルできる）ときだけ成立する。publish していない構成では、既定の完了経路は折りたたみの中の貼り付けになる。ホストの agent dir を使えるなら `pi /login` でもよく、その `auth.json` を GUI が読む（保存先が同じになるので、どの経路でも資格情報は 1 つ）
- 別マシンのブラウザしか無い場合: コールバックは届かない。折りたたみの中の貼り付け経路（ブラウザの最後の画面の URL / コード）でだけ完了できる
- LAN / インターネットへの公開、複数人での利用、リモート提供は SIWC の利用条件の対象外。ログインのない BFF の前提（[README](../README.md#セキュリティ)）を崩さない

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

## モデルカタログの取得と更新

チャットのモデル一覧（`GET /api/runtime/models`）は BFF のメモリ上にある SDK のカタログを正とし、アプリ側のカタログキャッシュは持たない。BFF が pi.dev のカタログへネットワークで取りに行くのは、設定 → モデル（`/settings/models`）の [カタログ更新] を押したときだけ。定期自動更新・起動時更新・キー保存に連動した自動更新は持たない。

- 起動時と通常の再計算は、SDK 同梱カタログと SDK が持つ overlay から組む。ネットワークは取らない
- [カタログ更新] は pi.dev の provider 別カタログを取り直し、取得結果は SDK が overlay へ永続化する。アプリ DB には保存しない（[persistence.md](persistence.md#モデルカタログのキャッシュsdk)）
- 取りに行く provider は SDK が credential を解決できる範囲に限る。キー未登録の provider が同梱カタログのままなのは仕様
- 更新でカタログから消えた保存済みの `allowedModels` / `defaultModel` は、既存の「カタログ外」表示に任せ、新しい救済 UI は作らない（次の保存では 400 になり得る）
- OpenRouter live の直接取得・合成は行わない。設定 → コンテンツ生成のカタログとは取得元も保存先も別として扱う

### [カタログ更新] の契約

- キー変更と同じロックで直列化し、取得・公開 state の再計算・応答の組み立てをその内側で 1 回ずつ行う。設定は変えないため、応答は `GET /api/runtime/models` と同じ形に `catalogError` を足したもの（`state` は持たない）
- 失敗の分類: 一部の provider が失敗した場合を部分成功、期限に当たった取得をタイムアウト、それ以外の例外を不明の失敗、`PI_OFFLINE` を取得しなかったこと、として区別する。期限切れと provider の失敗が同時のときは期限切れを優先し、成功時は `catalogError` を `null` にする
- 失敗しても 200 で一覧を返し、理由は `catalogError` にだけ載せる。カタログそのものを返せないときだけ `GET /api/runtime/models` と同じ 503 にする。生の例外・provider ごとの内訳は応答に出さない（ログは秘密マスクを通した分類だけ）
- この `catalogError` は今回の取得試行の失敗理由で、`GET /api/runtime/models` の失敗（一覧を取れない = 編集不可）とは別物。クライアントは注記にだけ使い、一覧の取得失敗としては記録しない
- 文言の正はサーバー側の定数（`server/src/model-settings.ts`）に置く。失敗は完結した 1 文で、クライアントは受け取った文と成功時の完了文言をそのまま出すだけにし、一覧が変わる / 変わらないをクライアント側の固定 suffix で補わない（部分成功と `PI_OFFLINE` で実際の変化が異なるため）
- 総時間の上限を設け、取得とそれに続く公開 state の再計算で同じ期限を共有する。期限に当たったら SDK の読み取りを中断し、公開 state は差し替えない（一覧と available は現在値のまま）。共有ロックを期限以上に保持せず、後続のキー変更を塞がない
- `PI_OFFLINE` が設定されているときは取りに行かない。SDK はネットワーク取得を明示すると offline の判定を上書きするため、その前に BFF で止める。この場合も一覧は返す（`.env.example` に載せ、Dockerfile では設定しない）
- SDK の鮮度窓は更新のたびに無視して再検証するが、内容が同じなら再取得されない（ETag による 304 があり得る）。「更新しました」は「モデル数が増えた」を意味しない

## プロバイダーごとのメモ

`provider_memos` は「この provider にどのキーを入れたか」（無料枠 / 課金枠、個人 / 会社アカウントなど）を人間が思い出すための任意文字列で、**キーの登録有無（`managed`）とは独立**している。キーは再表示しないため、画面からでは見分けられない。

- 保存先を `provider_credentials` に相乗りさせないのは、`managed`・[削除]・degraded が「この画面で登録したキーの行」を意味する契約を守るため。メモだけの行が credential にあると、キーが無いのに `managed: true` になり、`deleteKey` が SDK の overlay を消しにいく。`apiKey` が `NOT NULL` なので列を足すだけでもメモ単独の行は作れない
- `putMemo` は `trim()` して空なら行を消し（未設定へ戻す）、それ以外は upsert する。行が無い = 未設定を保つため、空文字の行は残さない
- メモ欄はキーの登録可否（`canSetApiKey`）と無関係に出し、ambient / keyless の provider にも書ける。キーの行と同様に `managed` / `degraded` / `orphan` の意味は変えない
- キーを削除してもメモは消さない。ユーザーが書いたテキストを黙って消さないため、消したいときはメモ欄を空にして保存する
- カタログから消えた provider のメモは `orphan: true` のカードとして出続け、空にして保存すると消える
- この画面でサインインを完了できず、この画面でキーも登録できず、カタログ内でこの画面のキー保存行を持たない provider はプロバイダー一覧から行ごと落とす（[クライアント](#クライアント)）。そこに書いたメモは画面から見えなくなるが、DB には残る
- メモは秘密情報ではない。マスカー（`retainSecret`）に登録せず、代わりにログ・health・エラー文言のどの経路にも値を載せない（[secrets.md](secrets.md)）

## カスタムプロバイダー（オンメモリ）

Ollama / LM Studio / vLLM / llama.cpp などの OpenAI 互換エンドポイントを、`models.json` を手で書かずに 設定 → モデル（`/settings/models/providers`）から登録する。プロバイダー APIキーの保存（アプリ DB）とは別の経路で、**このプロセスのメモリだけ**が定義とキーを持つ。

- 一覧は通常のプロバイダー一覧に混ぜず、専用の「カスタムプロバイダー」セクションに置く。`providers[]` には `custom: true` で載せ、「モデルを選ぶ」タブの候補とカタログ表示が使う。管理の正は `customProviders[]` で、こちらもキーは返さない（有無だけを `hasKey` で表す）
- **1 provider = 1 model**。1 台の PC で複数モデルを同時に動かさない前提なので、複数モデルを 1 provider で使うときは `models.json` の領域に委ねる。API は `openai-completions` 固定で、モデルは `input: ["text"]` / `reasoning: false` / `cost: 0` として登録する
- **キーは必須**（8..2048 文字）。認証のないローカルサーバーにはダミーを入れる。ダミーも `Authorization: Bearer <キー>` として送られ、Ollama / LM Studio / vLLM などは無視する。キーは応答に返さず、更新時の空欄は既存を維持する
- **contextWindow はモデルごとの必須選択**で既定を持たない。自由入力ではなく、8K / 16K / 32K / 64K / 128K / 256K / 384K / 512K のプルダウン（`8K (8,192)` の形）から選ぶ。保存済みの値がプリセットに無い定義（以前の自由入力など）は、その値を選択肢に 1 件だけ足して丸めない。OpenAI 互換 API からは窓を取得できず、ローカルモデルの窓は大きくないため、SDK の既定（128000）は使わない。`maxTokens` は任意で、既定は `server/src/custom-providers.ts` が持つ。実モデルより大きい値を選ぶと送信がコンテキスト超過で失敗するので、画面は保存を止めないが注意を出す
- **provider id は作成後に変更できない**。built-in / `models.json` / 登録済みの provider と衝突したら 400。カタログから外れた provider の `provider_credentials` / `provider_memos` の行（孤立行）が同じ id に残っているときも 400 にし、先にその行を削除させる（行があると `managed: true` / `keyUpdatedAt` の契約が崩れ、カスタム画面からは削除できないため）`baseUrl` は `http` / `https` のみで、userinfo・query・fragment を拒否し、末尾の `/` を落とす
- 登録は `ModelRuntime.registerProvider()`、キーは `setRuntimeApiKey()`（runtime overlay）に置く。`ProviderConfigInput` にキーを入れないため `auth.source` は `runtime` になり、`credentialKind` は `api_key` になる。カスタム provider では `auth.json` の OAuth を読まない（`hiddenStoredOAuth` は常に false）
- 削除は `removeRuntimeApiKey()` → `unregisterProvider()` の順に行う。`unregisterProvider()` は runtime overlay を消さないため、逆にすると同じ id を再登録したときに古いキーが復活する（SDK 1.4.0 まで確認）
- 作成・更新は全か無か。登録の検証に失敗したら 400（SDK は変更前に検証するので旧登録は残る）、キーの適用に失敗したら登録と overlay を巻き戻して 503 にする。SDK の生の例外文言は応答へ出さない
- 管理 API は `/api/settings/custom-providers` に置き、`/api/settings/models/:provider/...` と同じ深さの param ルートを並べない（並べると provider id が `custom` の既存 provider のキー / メモ API を食う）。既存の `PUT/DELETE /:provider/key` / `PUT /:provider/memo` / `POST /:provider/resync` はカスタム provider を 400 にする。`provider_credentials` / `provider_memos` に行を作らないため、再起動後に孤立行が残らない
- **再起動すると定義とキーは消える**が、`allowedModels` / `defaultModel` はアプリ DB に残る。残ったカスタムモデルはカタログ外になるため、外すまで利用可能なモデルを保存できない（未ロードの会話は復元時にアプリ既定へフォールバックする）。同じ provider id とモデル id で再登録すれば、選択は再び有効になる。既定モデルに指定していた場合、再起動後は既定を解決できず新しい会話を始められない
- 将来の永続化は `models.json` ではなくアプリ DB を予定する（JSONC のコメント消失・手編集との競合・キーのファイル混入を避け、保存の正をアプリ DB に揃える）。今回はオンメモリのみで、`models.json` の GUI 編集・built-in の baseUrl 上書き・モデルの自動 discovery・`openai-completions` 以外の API・compat / sampling / vision / reasoning・OAuth / メモ・保存時の疎通テストは非ゴール
- `PI_OFFLINE` は登録・削除に影響しない（ネットワークに出ない）
- セキュリティ: ダミーを含むキーは `retainSecret()` でプロセス生存中のマスク対象にし、応答・ログ・会話表示に出さない。`baseUrl` へは BFF がそのまま接続する（ログインの無い画面から任意の送信先を登録できる）ので、信頼できるサーバーだけを指定する。ローカル LLM がコンテナの外にいるとき、BFF の `127.0.0.1` はコンテナ自身を指すため、ホストの LAN アドレス（例: `http://192.0.2.10:11434/v1`）や同一ホストの Docker なら `host.docker.internal` を使い、`/v1` まで含める

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

`applied_unsynced` は「永続化は確定した」ので 2xx とする（成功と失敗の混在を HTTP で二重表現しない）。`not_stored` は DB の**単一ステートメント（自動コミット）が commit されなかった**場合だけに使い、DB 書込後に DTO の組み立てや state の再計算が失敗した場合は `applied_unsynced` として degraded を残す。利用可能なモデルの保存だけは SDK 呼び出しを持たないため `applied` だけを返す（DTO を組めないときも、保存が確定していれば `applied` として次の GET に追随させる）。GET は `state` を持たない純粋読取で、変更も修復も行わない（認証種別は SDK の同期スナップショットと、runtime overlay があるときだけ行う `auth.json` の表示専用読取から組む）。

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
| GET | `/api/settings/models` | 保存値（`allowedModels` / `defaultModel` / `ignoredEnvironmentVariables`）と provider 一覧（auth 状態・credentialKind・oauthLoginLabel・hiddenStoredOAuth・canSignInHere・managed・keyUpdatedAt・degraded・orphan）。純粋読取 |
| PUT | `/api/settings/models/allowed` | 利用可能なモデルとアプリ既定モデルの一括保存。両方 `null` が未設定へ戻す |
| PUT | `/api/settings/models/:provider/key` | APIキーを登録（既存は上書き） |
| PUT | `/api/settings/models/:provider/memo` | provider のメモを保存（`trim` して空なら行を削除）。上限 500 文字 |
| DELETE | `/api/settings/models/:provider/key` | この画面で登録したキーを削除（行が無ければ 400） |
| POST | `/api/settings/models/:provider/resync` | degraded の回復。body 無し |
| POST | `/api/settings/models/:provider/login` | OAuth サインインの開始。進行中の二重開始は 409。応答は GET と同じ形で、進行中の認可 URL を `providers[].login` にだけ載せる |
| POST | `/api/settings/models/:provider/login/code` | ブラウザの最後の画面の URL / コードを待機中の SDK へ渡す。body は `{ "code": "…" }` |
| DELETE | `/api/settings/models/:provider/login` | 進行中のサインインの中断と、終端した結果表示の消去（冪等）。body 無し |
| POST | `/api/settings/models/:provider/logout` | サインアウト（`auth.json` の OAuth を削除）。保存済み OAuth が無ければ 400、進行中は 409、この画面で登録したキーは残す。body 無し |
| POST | `/api/settings/models/catalog/refresh` | pi.dev の provider 別カタログを取り直す。body 無し。取得失敗でも 200 で、理由は `catalogError` にだけ載せる |
| POST | `/api/settings/custom-providers` | カスタムプロバイダーを登録する（メモリのみ）。body は `{ id, name?, baseUrl, apiKey, model }` |
| PUT | `/api/settings/custom-providers/:provider` | カスタムプロバイダーを更新する。provider id は変更不可、`apiKey` の空欄は既存を維持 |
| DELETE | `/api/settings/custom-providers/:provider` | カスタムプロバイダーを削除する。body 無し。runtime overlay を先に外す |

`canSetApiKey` は SDK の `auth.apiKey.login` の有無で判定する（ambient / keyless provider は login を持たない）。詳細な DTO と応答は [api.md](api.md#利用可能なモデルとプロバイダーapiキー)。

## クライアント

- 画面は `/settings/models`（モデルを選ぶ。既定）と `/settings/models/providers`（プロバイダー）のタブ。**タブにするのは同じ対象を別の面から見るとき**で、hook / API が別でも対象が同じか、読み取り専用で面ごとに取得と操作が閉じているならタブにしてよい（設定 → ファイルや[ランタイム](frontend.md#url-と画面の対応)も同じ）。コンテンツ生成はモデルと別セクションに置き、共有行とキーの別の面として画像・TTS・BGMに分ける。Web検索は対象そのものが別なのでルートに置く。タブ語彙は `client/src/lib/settingsNav.ts` が正で、URLと `routePath` が同じ値を使う。旧 `/settings/models/content`・`/settings/models/web-search` のエイリアスは持たず、未知のサブセクションや既定タブの明示は既定へ畳む。タブ行は `client/src/components/SettingsTabs.tsx` と `SettingsPageLayout` の任意スロットを使い、singleColumnでは選択中のタブを可視域に入れる。
- hook は設定の面ごとにその面のページが持つ（`ModelSettingsPage` は `useModelSettings`、`ContentSettingsPage` は `useContentSettings`、`WebSearchSettingsPage` は `useWebSearchSettings`）。開いたときだけ取得するため、どの画面も他の面の設定を読み込まない。モデル画面の未保存の下書き（モデルの選択・既定モデルと、provider ごとの apiKey / メモ）は `ModelSettingsPage` の親が持ち、タブ切替・provider 切替・検索で再マウントしても下書き・note・カタログを失わない。カタログと設定は独立に取り、片方の失敗で他方を捨てない。面のツールバーの [再読み込み] はその画面の hook だけを取り直し、他の面の注記を消さない。取得中フラグは破棄された要求の完了でも解除する（`createLoadingTracker()`。解除を応答の適用可否で分岐すると、変更操作と重なったときに再読み込みボタンが無効のまま残る）
- 面のツールバーの [カタログ更新] は `/settings/models` と `/settings/models/providers` の両方で出し、更新中・ランタイム不可・カタログ取得失敗（編集不可と同じ判定）では無効にする。押下すると応答の一覧をその場で反映し、直後に `GET /api/runtime/models` は取り直さない（二重取得と、直後の取得失敗で反映済みの一覧を消す事故を避ける）。health の再取得は変更系と同じ順序でだけ揃える。結果は 1 行の注記に、成功時は完了文言、失敗時はサーバーが返した文をそのまま出す。HTTP が失敗したとき（503 を含む）は一覧と取得エラーを変えず、注記だけを差し替える
- 「モデルを選ぶ」タブは、候補を「認証済み provider のカタログ全件」と「カタログ外の残存エントリ」の和集合で組む。認証が設定されていない provider の選択は行に出さず、下書きからも落として保存しない（`pruneAvailabilityDraft()`）。カタログ外の残存だけは保存が 400 になるため、認証が無くても警告付きで出して外せる。折りたたみ中は行を描画せず、既定は全部閉じる（検索中の該当 provider と、警告のある provider だけ開く）。検索は DOM ではなくカタログのデータ（provider / モデル名 / ID）に当てて該当 provider を自動展開し、「選択済みのみ」でチェック済みだけに絞る
  - provider 行はバッジと `利用可能 a/b ・ 選択 c`（a/b はカタログ、c は下書き全体の選択数）を出し、[すべて選択] は認証済み provider だけ、[すべて解除] はカタログに無い provider でも保存済みを外せる。provider 群はカタログ順（「プロバイダー」タブと同じ）で表示する。これは表示順の説明だけで、保存値と既定モデルの解決には関係しない（未設定でもアプリが `getAvailable()` の先頭を既定にすることはない）
  - 未認証の provider はカタログ外の残存があるときだけ警告付きで出し（カタログ全件は出さない）、外せる（`allowedModelsOutsideCatalog()` 相当の判定を `candidateGroups()` が行と警告に写し、認証が無い provider のカタログ内の選択は行に出さない）。選択 0 件は固定バーで保存を無効にし、理由として「空の選択は API で「制限なし（全モデル）」へ正規化されるため、この画面からは送らない」を示す
  - アプリ既定モデルは `ModelDefaultPicker`（native popover + listbox。`composer/AgentPicker.tsx` と同じ組み方）で選び、先頭に「未設定」を残す。選択が 0 件のときは選べない理由をピッカーの下に出す。行は名前と ID を分け、検索は名前 / ID に当てる
  - 保存は本文の外に固定した下部バーにまとめ、変更がなければ [モデル候補を保存] を無効にし、差分があれば [変更を破棄] / [モデル候補を保存] を出す。保存で利用可能なモデルが 0 件になるときと既定が未認証のときは、純関数の文言で画面内の確認（[保存する] / [キャンセル]）を出し、後者は保存前から警告を出す（固定バーの中で完結させ、共通の確認ダイアログは使わない。判定は `availabilitySaveOnSubmit()` の純関数で固定し、同意するまで PUT を送らない）。成功時は応答値から下書きを作り直す。設定 API の保存値が実際に変わった場合も下書きを戻すが、配列参照だけが変わって内容が同じ場合は編集中の下書きを保つ。カタログの更新（キー操作での再取得・再取得の失敗で `catalog: null` になる場合）だけでは下書きを置換しない（`availabilityDraftState()` が保存値の変更と、カタログ無しで作った初期値の初回カタログ到着だけを作り直しの条件にし、認証が外れた provider の選択は `pruneAvailabilityDraft()` で下書きと比較基準から落とす）
  - 選択の正は `GET /api/settings/models` の `allowedModels` だけで、カタログは available と候補の表示にしか使わない。カタログを取得できないときは `catalogError` で編集不可を出し、プロバイダータブのキー操作は妨げない（`catalog === null` は初期ロード中も真になるため、編集可否の判定には使わない）
  - 保存後は health とカタログを取り直して、入力欄のモデル候補を追随させる。live の会話のモデルを切り替えないことを画面に注記する（[model-effort.md](model-effort.md#既存の会話への影響認証の変更)）
- 「プロバイダー」タブは左の一覧（`GET /api/settings/models` の provider を「設定済み（`auth.configured` / `managed` / メモあり / 利用可能モデルあり）」と「未設定」に分け、検索は provider 名 / ID。件数メタは `available/catalog` または未反映・カタログ外）と右の詳細（APIキーの登録・上書き、メモ、削除、再同期、利用可能数、`degraded` の案内）の master-detail。この画面でサインインを完了できずキーも保存行も無い provider は一覧から落とし、判定は `groupProviders()` の 1 箇所にだけ置く（`orphan` と保存行は落とさず、[削除] / [再同期] の導線を消さない）。削るのが表示だけなのは、「モデルを選ぶ」タブの provider 名とバッジが同じ payload の全件を使うため。詳細の上部にキーの平文保存と「BFF を LAN / インターネットへ公開しない」注意を既定で畳んで出し（1 行の要点 + 展開で全文）、プロバイダーを切り替えても消さない。キー保存後に「モデルを選ぶ」タブへ戻る導線を置き、固定バーではキー・メモが各保存ボタンで即時保存されることを区別する。モデル一覧の重複表示（旧 ModelTable）は削除した
  - 詳細は認証バッジ（未設定 / 環境変数（変数名）/ 保存済み（auth.json）: <OAuth の表示名 or APIキー> / この画面で登録済み（実効）/ 保存済み（未反映）/ 削除が未反映 / カタログ外）を出し、`canSetApiKey` のときだけキー入力、`managed` のときだけ削除（確認に既存会話への影響を出す）、再同期可能な `degraded` のときだけ再同期を出す。キー最終保存は `managed` の provider だけに「保存日不明」を含めて出す
  - `hiddenStoredOAuth` の provider には、この画面のキーが保存済み OAuth を覆っていることと、キーを削除すれば戻ることを注記する（[認証ソースと優先順位](#認証ソースと優先順位)）
  - 見出しの 1 行メタ（`利用可能 a / カタログ b`・`キー最終保存: …`・`最終使用: …`）は、認証バッジと同じ寸法のチップ（`client/src/components/model-settings/MetaChip.tsx`）で組む。チップの色は警告の有無にだけ使い、日時や件数の値では変えない（情報の種別ではなく、対処が要るかを見せる）
  - 未反映の案内文（`degradedNotice`）は、その詳細で実際に押せる回復操作に合わせる。カタログ外（`orphan`）の `apply` は resync API も 400 にするため [再同期] を案内せず、[削除] とカタログ復帰を案内する
- プロバイダー詳細の認証方法は、2 経路とも使える provider（`canSetApiKey && supportsOAuth`）でだけタブ（`APIキー` / `サインイン`）に分ける（タブ名は provider 中立。カタログ外はサインインの中身が無いのでタブを作らない）。既定は実効側で、実効側に「使用中」、`サインイン` 側には進行中 / 失敗の印を出し、読み上げのラベルにも状態を含める。**「使用中」は実効が OAuth かこの画面のキーのときだけ付け、環境変数 / `models.json` / 認証なしでは付けない**（どちらを使っているかは認証バッジが示す）。タブの選択はこの画面のローカル状態にし（設定のタブは URL が正なので、その規則を持ち込まない）、provider を切り替えたら実効側で初期化する。切替ではサインインのパネルをアンマウントせず（進行中の表示と、自分が開いた空タブの参照を保つ）、非表示側のペインは `hidden` / `inert` でフォーカス対象から外す（[frontend.md](frontend.md#url-と画面の対応)、[OAuth サインイン](#oauth-サインイン)）
- プロバイダー詳細の OAuth サインインは provider の `oauth.loginLabel` をボタン名にし（無ければ汎用の文言）、[サインアウト] は `auth.json` の OAuth があるときだけ**サインインのタブの中に**出す。未認証の説明と注意（期限 / 利用条件）はサインインの操作の面に常時出し、押す前に行き先と条件が読めるようにする。サインインの操作は DTO の `canSignInHere` が真のときだけ出し、未指定なら出さない（fail-closed）。false のときは理由（この画面では扱えない方式であることと、同じ agent dir を使う `pi /login` の案内）に置き換え、[サインアウト] は条件どおり残す。進行中は主文と補助行・認可 URL・貼り付け・[中断] を出し、終端した結果は [閉じる] で消す。進行中は `GET /api/settings/models` をポーリングし（間隔は `client/src/lib/modelSettings.ts`）、終端したら health とカタログも取り直す（[OAuth サインイン](#oauth-サインイン)）
- メモ欄はキー入力とは別の `<form>` にした `<textarea rows={2} maxLength={500}>` と [メモを保存] で、Enter がキーの保存を走らせない。入力値は `provider.memo` が変わったときだけ同期し、dirty（`trim` 後の値が保存値と違う）のときだけ保存を有効にし、未保存の印を出す。保存に成功したら応答の `trim` 済みの値で入力値を戻す。メモの保存は SDK に触れないので health / カタログを取り直さず、進行中の `reload()` の応答で保存直後を上書きされないよう先行ロードの無効化だけ行う。`runtimeAvailable: false` のときは入力欄と保存を disable し、runtime 停止時の注意書きにメモも含める。カタログ外のメモだけの provider には「キーの登録はできません（メモは保存できます）」と案内し、キー入力は出さない
- 「プロバイダー」タブのカスタムプロバイダーは、通常の一覧とは別のセクションに一覧・[カスタムプロバイダーを追加]・追加 / 編集フォーム・削除確認を置く。注意書きは定義の有無・選択中の provider・検索語に依存させず、専用セクションの見出し下に常時出す（singleColumn で一覧を畳んだときだけ詳細側に移し、同時には出さない）。左列は幅が狭く注意書きを開いたままだと一覧が押し下げられるため、要点（メモリのみ・再起動で消える）の 1 行だけを常時出し、残りの理由は既定で畳む（詳細側に移したときも同じ形）。`custom: true` の行は通常の一覧（設定済み / 未設定とその件数）から除外し、判定は `groupProviders()` の 1 箇所にだけ置く。カスタムを選ぶと通常の `ApiKeySection` / メモ / OAuth / 再同期の代わりに専用フォームを出し、1 provider = 1 model の入力（provider id / 名前 / baseUrl / APIキー / モデル ID / contextWindow / maxTokens）と、オンメモリで再起動すると消えること・再起動後にカタログ外のモデルが残ること・同じ id とモデル id で再登録すれば戻ること・既定モデルの影響・キー必須 / ダミー / `Authorization` ヘッダ・信頼できる baseUrl だけを指定することを常時出す。フォーム検証・送信本文・注意文言・削除確認は `client/src/lib/customProviders.ts` の純関数が持ち、サーバーと同じ境界で保存前に止める。フォームの 2 列の行は、片側にだけ補足文やエラーがあっても、入力欄の高さと行の上端が揃うようにする。**名前は表示名だけ**で、空欄なら provider id を名前として使う。どちらの場合もモデル ID には付かず、上流の `openai-completions` へは `model` として `model.id` をそのまま送る
- コンテンツ生成（`/settings/content`）のAPIキーは画像・TTS・BGMのタブ外で共有する。取得前と未設定はタブ行を出さない（取得前からタブがある設定 → モデルとは異なる）。操作と注意書きは [image-generation.md](image-generation.md#設定画面)、[speech-generation.md](speech-generation.md#設定画面)、[bgm-generation.md](bgm-generation.md)。
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
- `models.json` のカスタム provider / baseUrl の編集、既定 Effort（`PI_THINKING`）の GUI 化、プロジェクト / エージェント単位のモデル制限は対象外
- OAuth サインインは provider 側のフロー次第で失敗する（[OAuth サインイン](#oauth-サインイン)）。この画面は「認可 URL + 貼り付け」と「デバイスコード」だけを扱い、許可リストに無い provider はサインインの操作を出さない。許可リストは SDK の flow の変更に追随しないため、**本当は完了できる provider を隠す**方向にも外れる（見落としは網羅テストが検出するが、分類の見直しは人の判断）。`models.json` で `oauth: "radius"` のように任意の provider へ flow を割り当てた場合も、許可リストに無いので隠れる側に倒れる。組み込み id を `models.json` で上書きしたとき（flow の差し替え / `apiKey` の追加）は許可リストと「行ごと落とす」の前提が崩れるが、実際の表示は DTO のフラグの判定に従う。進行中のサインインは開始から一定時間で自動的に中断され、それまではコールバックの待受（固定ポートの provider は `1455`）を保持する
- 空タブの自動遷移はブラウザの popup blocker の挙動に依存する（拒否されたときはフォールバックのリンクが出る。リンクも開けない環境では [URL をコピー] が唯一の導線になる）。空タブを開いた直後に provider を切り替えるとそのタブは閉じるが、進行はサーバー側で続き、戻ったときは状態とリンクが出る。貼り付け待ちは SDK が求めた短い間だけなので、折りたたみを開いた時点でフォームが出ていないことがある（そのときは受け付けていないことを出す）
- `auth.json` の読み取りは表示専用の 1 回読取で、SDK が実際に解決する資格情報と時点がずれ得る（外部の `pi /login` / `logout` の直後など）。種別が変わっても認証の解決結果は変えないので、表示が一時的に古くなるだけで実害はない。`hiddenStoredOAuth` の未知（読取失敗）と「OAuth が無い」は画面では区別しない
- [カタログ更新] は pi.dev の応答遅延・レート制限で失敗し得る（期限と固定文言で閉じ、リトライはしない）。更新後の一覧内容は pi.dev 側に依存するため、テストで固定できるのは呼び出し契約まで
- 「最後にいつ更新したか」は画面から分からない。`models-store.json` の overlay は再起動後も効くが、一覧の出どころ（同梱 / overlay / live）は示さない
- 更新で消えたモデルを使っていた未ロードの会話は、復元時に別モデルへフォールバックし `model_change` として保存され得る（アプリ既定が未設定だと開けない。既存挙動）

## 検証

実 API は呼ばず、ダミーキーと fake / stub で検証する。

- `server/test/app-db.test.ts` — v4 → v5 / v5 → v6 / v6 → v7 の加算移行、`model_settings` の CRUD、空配列 = 制限なしの正規化、両方 NULL の行削除、壊れた JSON の 503、`provider_memos` の CRUD（上書き・削除・空文字行 = 未設定）、`provider_credentials.updatedAt` の移行（既存行は NULL のまま・キーは消えない）と再実行の冪等性、新規 DB の列、`sanitizeError` の境界
- `server/test/model-settings.test.ts` — GET / PUT / DELETE / resync の契約、DB-first、1 回だけの再試行、`reapplyStoredKey()`（行が無い provider は触らない・SDK の反映失敗と DB の読取失敗は `degraded: "apply"` で例外を出さず、復旧後の resync で解除・成功で解除）、degraded の解除と記録と DTO を組めないときの `managed` の補正、利用可能なモデルの正規化・検証（カタログ外・既定が選択外・形式・重複）と 503、メモの `trim`・空で削除・対象外 400・DB 失敗 503・メモ値を応答とログへ出さないこと・degraded を作らないこと、GET の 4 経路（カタログ / credential 行 / メモ行 / degraded）とメモだけの orphan の扱い、キー削除後もメモが残ること、`keyUpdatedAt` が GET / PUT に載り移行前は null で resync / 削除では変わらないこと、`credentialKind` / `oauthLoginLabel` の写像と `hiddenStoredOAuth` の条件（runtime overlay が保存済み OAuth を覆うときだけ true・読取失敗は false・auth.json を読むのは runtime のときだけ）、起動適用（model_settings と provider_credentials の独立した読取・setter → refresh の順序・マスク登録の順序）、別 provider の並行 PUT の直列化、lock の rejected Promise、キー値を含む例外が応答とログへ漏れないこと、カタログ更新の分類（成功・一部失敗・期限の優先・例外の固定文言と秘密マスク・`PI_OFFLINE`・一覧を返せないときの 503）とキー変更との直列化、期限が取得と再計算で共有され、期限後も一覧を保ってロックを解放すること
- `server/test/model-catalog-refresh.test.ts` — 実 SDK + 隔離した agent dir で、他プロセスが SDK の認証ストアのロックを保持していても状態再計算が期限どおり閉じ、公開 state（一覧）を現在値のまま保つこと（期限が伝わらないとロック待ちで期限を超える）
- `server/test/model-settings-api.test.ts` — HTTP 契約（200 `applied` / `applied_unsynced`、503 `not_stored`、400）、メモの 200 / 400（500 文字超は route の zod）/ 503 と再起動後の読み出し、再起動後の適用、DB 不通、health とログのマスク、`ignoredEnvironmentVariables`、`keyUpdatedAt` が GET / PUT に載ることと移行前の行が null になること、`auth.json` の保存 OAuth がこの画面のキーに覆われたときだけ `hiddenStoredOAuth` が立ち、削除で戻ること・トークンを応答へ載せないこと、削除が未反映の間は `managed: false` / `degraded: "remove"` のままで実効が runtime に残り（DELETE の再実行は 400）、再同期で保存済み OAuth へ戻ること、カタログ更新（`allowNetwork: true` / `force: true` 付きで 1 回だけ呼ぶこと、一部 provider 失敗・abort・取得の例外・`PI_OFFLINE` が 200 と固定文言になること、生の例外文言を応答へ出さないこと、カタログを返せないときとランタイム無しの 503、キー変更 PUT との直列化、状態再計算が取得と同じ期限を受け取ること）
- `server/test/custom-providers.test.ts` — カスタムプロバイダーの検証（id の形・baseUrl・モデル・キーの長さ・maxTokens の既定）、Store（複数・並び・要約にキーを載せない）、作成 / 更新 / 削除の順序と巻き戻し（登録 → キー適用、失敗時の全か無か、削除は overlay → 登録の順）、id 衝突、既存 key / memo / resync の 400、ランタイム無しの 503、ロックの直列化、`custom: true` と `customProviders` の応答、カスタムでは `auth.json` を読まないこと
- `server/test/custom-providers-api.test.ts` — POST / PUT / DELETE の HTTP 契約（200 `applied`、400、503 `{ error }` で `not_stored` を付けない）、GET にキーが出ないこと、`provider_credentials` / `provider_memos` に行を作らないこと、既存 key / memo / resync の 400、キー適用失敗時の巻き戻し、ロックの直列化
- `server/test/custom-providers-runtime.test.ts` — 実 SDK + fake の OpenAI 互換 HTTP サーバーで、登録 → `GET /api/runtime/models` に available で載る → `completeSimple` が `Authorization: Bearer <キー>` で `/v1/chat/completions` を呼ぶこと。名前を空欄にした登録では provider の表示名が provider id になり、要求本文の `model` とモデルの表示名はどちらもモデル ID のまま（provider id を接頭しない）であること。実 LLM は呼ばない
- `server/test/provider-key-runtime.test.ts` — `CredentialCommit` の写像（CSE の照合・開始前 abort・実行中 abort・未知の例外）、`canSetApiKey` と `canSignInHere`（許可リスト）の写像、`credentialKind` の `isUsingOAuth` への写像、`storedCredentialKind` が `auth.json` から種別だけを返し、読取失敗を不明へ縮退させること
- `server/test/oauth-login.test.ts` — interaction の分岐（`auth_url` / `device_code` / `progress` / `manual_code` / 未対応の `select`）、サインインの可否の許可リスト（許可リストの評価・OAuth を持つ組み込み provider の網羅分類・login API が許可リストを見ないこと）、開始の応答が認可 URL を待つこと、進行中の二重開始 409、貼り付けの受け渡しと待機していないときの 400、中断の state / `signal` / 再計算（終端後の消去は冪等）、失敗分類（port 競合・拒否・未対応・不明）と生の文言を応答へ出さないこと、`http(s)` 以外の URL を公開しないこと、サインアウトの対象判定と SDK 失敗の 503、成功を公開 state の再計算後に公開すること（再計算待ちの間も認可 URL / 貼り付け欄を載せない・中断で成功を取り消さない）、認可 URL の発行前に中断したあとの prompt を拒否して abort 済み signal に listener を残さないこと、サインアウトのキー写し直しを再計算前に行い失敗しても応答を変えないこと、認可と貼り付けの案内文がコールバックのポート / パスを名指ししないこと
- `server/test/oauth-login-api.test.ts` — 開始 → 貼り付け → 完了の HTTP 契約（`providers[].login` の形・完了で認可 URL を落とすこと・`managed` は false のまま）、二重開始 409、中断で SDK の signal が abort されること、port 競合の固定文言、OAuth を持たない provider の 400 / サインアウト対象外の 400、本文の検証（空・上限超は SDK へ渡さない）、サインアウトでこの画面のキーの行が残り、SDK が消す runtime overlay を DB のキーで戻すこと（戻せないとき・復元の判断に使う DB の読取が失敗したときは `degraded: "apply"` として残し、再同期で回復できる）、認可 URL の発行前に中断されたサインインが後着の prompt を拒否して次のログインを塞がないこと、device id の永続化（再起動で同じ値・`u7agent` の名前で SDK へ渡る）
- `server/test/device-id.test.ts` — UUID の生成と保存、プロセスをまたいだ再利用、壊れた値の作り直し、書けない場所でのメモリへの縮退
- `server/test/model-state.test.ts` — `deriveModelState` / `readModelState`（選択リストの積・既定モデル・カタログの導出・可用 0・失敗時の安全な state）、`filterModelsByWhitelist()`
- `server/test/api.test.ts` — health から `runtimeDiagnostics` が消えたこと、モデルカタログ応答に whitelist 系フィールドが無いこと
- `server/test/redact.test.ts` — `createMutableSecretMasker` の swap と streaming masker への追随
- `client/test/customProviders.test.ts` — フォーム検証（id / baseUrl / キー必須と編集時の空欄 = 維持 / モデル ID / contextWindow / maxTokens）、contextWindow の選択肢（`8K (8,192)` の表記・プリセット外の保存値を丸めずに追加）、送信本文、複数登録、注意文言、削除確認
- `client/test/modelSettings.test.ts` / `client/test/modelSettingsPage.test.ts` — 表示変換（認証バッジ・並び・入力検証・カスタム provider の専用セクションと通常一覧からの除外・メモの検証・注記・回復案内）、OAuth セクションの表示条件（`oauthPanelView()` の loginLabel / サインインできるか（`canSignInHere` の未指定は出さない）/ サインインの操作を出せない理由 / サインアウト / カタログ外の非表示 / 状態種別（未認証・サインイン済み・URL 未着・承認待ち・貼り付け待ち・デバイスコード・成功・中断・失敗）/ 折りたたみ・フォーム・フォールバックリンク（折りたたみと独立に認可 URL と遷移結果で決まる）の表示条件 / 主文と補助行の併記）、認証方法のタブ（出す条件・既定・「使用中」・印・読み上げラベル `providerCredentialTabs()`）、OAuth セクションの描画（開始・サインアウト・タブと非表示側の `inert`・認可 URL のリンク・折りたたみの中の貼り付けとコピー・注意行・中断・失敗の固定文言・[閉じる]・サインインできない provider の理由）、一覧から落とす条件（`groupProviders()` が落とす・キーを登録できる/保存行/メモの行は残す）と、落としても「モデルを選ぶ」タブの provider 名とバッジが全件のままであること、認証後の取り直し（health とカタログへ同じ適用可否を渡すこと）、`providerUsage()`（最初の `/` での分割・`model` 無し・複数セッション・空配列）、`null` の明示リスト展開（利用可能な全モデル + 既定モデルの 1 件追加）・認証済み provider の絞り込み（`pruneAvailabilityDraft()` の除去と、表示の対象を揃える `candidateGroups()` の絞り込み）・カタログ外の残存エントリの警告付き表示・候補の並び/検索/集計・既定モデルの選択肢と検索・dirty 判定・provider 一括操作・確認文、タブと保存バーの初期描画（折りたたみの既定閉・警告のある provider の自動展開・変更なしと選択 0 件では保存無効）とカタログ外・未設定・環境変数の注記・カタログ取得失敗時の編集不可、プロバイダータブの一覧と詳細（平文注意の既定折りたたみ・メモ欄・保存ボタン・runtime 停止時の disable・メモだけの orphan の案内・保存済み OAuth の種別表示と、この画面のキーが覆っているときだけ出す注記（削除が未反映の間は [再同期] を案内すること）、キー最終保存（managed だけ・NULL は保存日不明）と最終使用（`sessionsLoaded` が false なら非表示・会話 0 件の managed は「会話はありません」・非 managed は会話があるときだけ）、`client/test/route.test.ts` のタブの正準化（未知のサブセクションと既定タブの明示、旧 `/settings/models/content`・`/settings/models/web-search` は `/settings/models` へ）
- `client/test/contentSettings.test.ts` / `client/test/contentSettingsTab.test.ts` / `client/test/contentSettingsPage.test.ts` / `client/test/settingsNav.test.ts` / `client/test/speechVoices.test.ts` — 共有キー、画像・TTSの選択とカタログ、TTSのお試し再生、URLが決める面、未設定と未同期の表示。BGMは固定モデルの読取専用表示・課金と外部送信の注意・お試し生成を出さない契約も検査する。
- `server/test/speech.test.ts` / `server/test/speech-catalog.test.ts` / `server/test/speech-tools.test.ts` / `server/test/speech-settings.test.ts` / `server/test/speech-settings-api.test.ts` — 音声生成の契約（[speech-generation.md](speech-generation.md#テスト)）
- `client/test/requestGate.test.ts` — 応答の適用可否（`createRequestGate`）、要求の追跡（`createRequestTracker`）、取得中フラグの解除（`createLoadingTracker`: 破棄された要求の完了で解除し、後続が在る間は維持する）
- `client/test/runtimePage.test.ts` — 設定 → ランタイムの 3 タブ（タブ行の `aria-selected` と既定タブ、アクティブな面だけが出ること）
