# 設定 API

設定 → 各セクションの HTTP 契約（モデル / Web 検索 / 会話タイトル / コンテンツ生成 / 作業フォルダの環境変数）。DTO の正は `server/src/schema.ts`、規約と索引は [api.md](api.md) を参照する。

## 利用可能なモデルとプロバイダーAPIキー

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/models` | 保存値（`allowedModels` / `defaultModel`）と provider 一覧（auth 状態 / credentialKind / oauthLoginLabel / hiddenStoredOAuth / canSignInHere / managed / keyUpdatedAt / keyAvailable / keyEvaluated / keyErrorMessage / canSetApiKey / orphan / degraded / login）。純粋読取 |
| PUT | `/api/settings/models/allowed` | 利用可能なモデルとアプリ既定モデルの一括保存。body は `{ "allowedModels": ["<provider>/<id>"], "defaultModel": "<provider>/<id>" }`（どちらも `null` 可） |
| PUT | `/api/settings/models/:provider/key` | APIキーを登録（既存は上書き）。body は `{ "apiKey": "…" }` |
| PUT | `/api/settings/models/:provider/memo` | provider のメモを保存（`trim` して空なら行を削除）。body は `{ "memo": "…" }`（0..500 文字） |
| DELETE | `/api/settings/models/:provider/key` | この画面で登録したキーを削除 |
| POST | `/api/settings/models/:provider/resync` | degraded（保存済み・未反映）の回復。body 無し |
| POST | `/api/settings/models/:provider/login` | OAuth サインインの開始（Sign in with ChatGPT など）。body 無し。進行中の二重開始は 409 |
| POST | `/api/settings/models/:provider/login/code` | ブラウザの最後の画面の URL / コードを待機中の SDK へ渡す。body は `{ "code": "…" }`（1..4096 文字） |
| DELETE | `/api/settings/models/:provider/login` | 進行中のサインインの中断と、終端した結果表示の消去（冪等）。body 無し |
| POST | `/api/settings/models/:provider/logout` | サインアウト（`auth.json` の OAuth を削除。この画面で登録したキーは残す）。body 無し |
| POST | `/api/settings/models/catalog/refresh` | pi.dev の provider 別モデルカタログを取り直す。body 無し。取得失敗でも 200 で、理由は `catalogError` にだけ載せる |
| POST | `/api/settings/custom-providers` | カスタムプロバイダーをアプリ DB へ保存して SDK へ適用する。body は `{ "id": "…", "name": "…", "baseUrl": "http://…/v1", "apiKey": "…", "model": { "id": "…", "contextWindow": 32768, "maxTokens": 16384 } }`（`name` / `maxTokens` は任意） |
| PUT | `/api/settings/custom-providers/:provider` | カスタムプロバイダーを更新する。body は `{ name?, baseUrl, apiKey?, model }` で、`id` は変更不可。`apiKey` の空欄 / 未送信は既存の暗号文を維持する |
| DELETE | `/api/settings/custom-providers/:provider` | カスタムプロバイダーを削除する。body 無し。DB 行を消してから runtime overlay → 登録の順に外す |
| POST | `/api/settings/custom-providers/probe` | カスタムプロバイダーの `GET {baseUrl}/models` を 1 回叩く。body は `{ provider?, baseUrl, apiKey? }`。接続できない場合も 200 の分類で返す |

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
      "keyAvailable": true,
      "keyEvaluated": true,
      "keyErrorMessage": null,
      "canSetApiKey": true,
      "supportsOAuth": true,
      "canSignInHere": true,
      "credentialKind": "oauth",
      "oauthLoginLabel": "Sign in with ChatGPT",
      "hiddenStoredOAuth": false,
      "orphan": false,
      "degraded": "apply",
      "login": {
        "status": "running",
        "authUrl": "https://<authorize-host>/…",
        "instructions": "…",
        "progress": null,
        "input": { "message": "…", "placeholder": "…" },
        "userCode": null,
        "error": null
      },
      "memo": "個人アカウントの本番キー"
    }
  ],
  "customProviders": [
    {
      "id": "local-llm",
      "name": "自宅のLLM",
      "baseUrl": "http://192.0.2.10:11434/v1",
      "api": "openai-completions",
      "model": { "id": "qwen2.5-coder:7b", "contextWindow": 32768, "maxTokens": 16384 },
      "hasKey": true
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
- `custom: true` は 設定 → モデルで作ったカスタムプロバイダー。**このプロセスで `registerProvider()` した id だけ**に付き、`providers[]` にも載るが（「モデルを選ぶ」タブの候補とカタログ表示が使う）、通常のプロバイダー一覧と件数からは除外する。管理の正は `customProviders[]` で、同じ id が両方に載る。built-in / `models.json` と衝突して登録できなかった DB 行には付けない（通常の一覧から built-in を隠さない）
- `customProviders[]` はカスタムプロバイダーの定義（`{ id, name, baseUrl, api, model: { id, contextWindow, maxTokens }, hasKey, degraded?, degradedMessage? }`）。**キーは返さず、有無だけを `hasKey` で表す**（暗号文の有無から導出）。`api` は v1 では `openai-completions` 固定で、1 provider = 1 model。保存の正はアプリ DB の `custom_providers` で、GET は復号しない（並びは追加順）。`degraded` は任意で、`apply` = DB 行はあるが register / キー適用が未完了、`remove` = 削除待ちの tombstone（`hasKey: false`）。未指定は「反映済み」。`degradedMessage` はその固定文言（master key 未設定 / 復号不能 / id 衝突）で、クライアントは原因を推測しない。`runtimeAvailable: false` の構成では `degraded` を付けず、DB の内容だけを返す
- `canSetApiKey` は SDK の `auth.apiKey.login` の有無。false の provider（ambient / keyless）はこの画面からキーを登録できない
- `canSignInHere` はこの画面で OAuth サインインを完了できる provider の印（**任意**。省略 = この画面ではサインインできない）。SDK の OAuth flow が求める対話は静的な metadata に現れず、`select` / `text` を求める flow も開始するまで分からないため、サーバーの許可リスト（「認可 URL + 貼り付け」と「デバイスコード」の方式）で判定する。`supportsOAuth`（OAuth を持つ印）とは別で、`POST /login` の対象判定と認証状態の解決には使わない（[model-settings.md](model-settings.md#oauth-サインイン)）
- `credentialKind` は SDK（`ModelRuntime.isUsingOAuth`）が見ている資格情報の種別（`oauth` / `api_key`、`null` = 認証なし）。**runtime overlay があるときは overlay の `api_key` になり、`auth.json` の保存値の種別は見えない**
- `oauthLoginLabel` は provider の `oauth.loginLabel`（例: `Sign in with ChatGPT`）。OAuth の表示名にだけ使う静的 metadata で、トークン・`clientId`・認可 URL は含めない
- `hiddenStoredOAuth` は `auth.source: "runtime"` の provider で、`auth.json` に保存された OAuth がこの画面のキーに覆われている印。BFF が `auth.json` を読み取り専用で見た**表示専用**の値で、読取失敗・壊れた JSON・保存なしは `false`（不明）へ縮退する。認証の解決・優先順位には使わない（[model-settings.md](model-settings.md#認証ソースと優先順位)）
- `orphan: true` は現在のカタログに無い DB 行。`name` は provider id になり、削除だけできる（再同期はできない）
- キー値・SDK の生ラベル・生の認証エラーは GET の応答に含めない。環境変数の**変数名**だけを `environmentVariables` に載せる（`GET /api/health` と同じ公開範囲）。`oauthLoginLabel` は provider の静的なログイン手段の名前で、認証情報ではない
- 変更系の本文は `{ "apiKey": "…" }` で、8..2048 文字。形が違う場合は 400（SDK / DB へ要求を出さない）
- `PUT /api/settings/models/:provider/memo` の本文は `{ "memo": "…" }` で、500 文字まで。`trim` して空なら行を消して `memo: null` に戻す。SDK 呼び出しを含まないため応答は常に `state: "applied"`。カタログに無い provider は credential 行かメモ行が既にあるときだけ受け付け、それ以外は 400（`このプロバイダーのメモは保存できません`）。500 文字超と形の違う本文は route の zod が 400 にする
- 200 の応答は GET と同じ形 + 必須の `state`。`applied` は反映まで成功、`applied_unsynced` は「保存済み・反映未完了」で、再同期 / 次回の変更 / 再起動で収束する
- 503 は `{ "error": "…", "state": "not_stored" }` で、何も保存されていないことを示す（DB 書込前の失敗、ランタイム初期化失敗、master key 未設定で暗号化できないなど）。400 は `{ "error": "…" }` だけ。`PUT /api/settings/models/allowed` もランタイムが無いときは 503 `not_stored`（カタログ検証ができないため）
- 保存済みのキーは AEAD の暗号文で、GET は復号しない。`managed`（行の有無）に加えて `keyAvailable`（復号できて SDK へ適用できる）/ `keyEvaluated`（復号を評価したか）/ `keyErrorMessage`（サーバーの固定文言）を返し、`managed: true` / `keyEvaluated: false` は「保存済みだが復号をまだ確認していない」で誤鍵・破損と断定しない。復号できない行は `degraded: "apply"` として [削除] / [再同期] の導線を残す。DELETE は復号が要らないため master key 無しでも通る（[secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）
- 400: 未知の provider / `canSetApiKey` が false の provider への PUT、登録行が無い provider の DELETE、再同期の対象外（カタログに無く degraded も `remove` でない）、メモの対象外 provider。サンドボックスは使わない
- `POST /:provider/resync` は冪等。degraded でない provider に送っても現在の DB 希望状態を再適用して 200 を返す
- `POST /api/settings/models/:provider/login` は OAuth サインイン（Sign in with ChatGPT など）を開始し、`providers[].login` に進行状態を載せた GET と同じ形を返す（アプリ DB を触らないため `state` は持たない）。`login.status` は `running` / `succeeded` / `failed` / `cancelled` で、`authUrl` は **`running` の間だけ**載る。`instructions` は進行中の**主文**、`progress` は**補助行**で、`progress` は `instructions` を置き換えない（両方載り得る）。`input` は貼り付け待ちの入力欄、`userCode` はデバイスコード方式のコードで、それ以外は `null`。失敗の理由は画面用の固定文言で `error` にだけ載せ、SDK / provider の生のメッセージは返さない。すでに `running` の provider への再開始は 409 `{ "error": "…" }` で、OAuth を持たない / カタログ外の provider は 400。`canSignInHere` が false の provider（この画面にサインインの操作を出さない provider）でも開始は受け付け、扱えない対話で固定文言の失敗になる（表示だけを制御する）。`succeeded` は公開 state の再計算が終わってから公開し、再計算を待つ間も認可 URL と入力欄は載らない（クライアントは成功を観測すると health / カタログの取り直しを止めるため）
- `POST /api/settings/models/:provider/login/code` は `manual_code` を待っている間だけ受け付け、待っていなければ 400。交換の完了は応答では待たず、クライアントが GET を読み直して拾う（応答は `running` のまま）
- `DELETE /api/settings/models/:provider/login` は冪等。進行中なら中断（SDK のコールバックサーバーと通信を閉じ、公開 state を再計算）し、終端していれば結果表示を消し、進行中も結果も無ければ何もしない。どれも 200 で GET と同じ形を返す
- `POST /api/settings/models/:provider/logout` は `auth.json` の OAuth を削除する（provider 側の失効はしない）。SDK は同じ provider の runtime overlay（この画面で登録したキー）も消すため、DB に残るキーの希望状態を公開 state の再計算前に写し直し、反映に失敗したときや復元の判断に使う DB の読取に失敗したときはカードの `degraded: "apply"` で [再同期] へ導く。`auth.json` に OAuth が無ければ 400、進行中のサインインがあれば 409。アプリ DB の `provider_credentials` は触らないので、この画面で登録したキーは残る。SDK の失敗は 503 `{ "error": "…" }`（固定文言）
- この 4 つの応答は GET と同じ形で、`state` を持たない（資格情報を Pi が持つため、キーの操作のような応答単位の「保存済み・未反映」は作らない。未反映は provider ごとの `degraded` に出る）。device id の置き場所・コールバックの待受（固定 / 動的ポート）と別マシンのブラウザの経路・実行形態ごとの扱いは [model-settings.md](model-settings.md#oauth-サインイン)
- `POST /api/settings/custom-providers` / `PUT` / `DELETE` はカスタムプロバイダーの登録・更新・削除（`/api/settings/models/:provider/...` とは別の名前空間に置き、`models` 配下の param ルートと衝突させない）。**DB を先に確定**し、応答は `GET /api/settings/models` と同じ形 + `state`。DB 確定前の失敗（DB 読取 / 書込、入力キーの暗号化、ランタイム未初期化）は 503 `{ "error": "…", "state": "not_stored" }` で、DB 確定後の register / キー適用 / 復号の失敗は 200 `applied_unsynced` + `customProviders[].degraded` にする（補償ロールバックはしない）。検証失敗は 400 `{ "error": "…" }`（id の形・id 衝突・baseUrl・モデル・キーの長さ・未登録・tombstone 中の ID）
- カスタムプロバイダーの `id` は `^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$` で作成後に変更できず、built-in / `models.json` / 登録済みの provider / DB のカスタム行 / 削除待ちの tombstone と衝突したら 400。カタログ外の provider に残った `provider_credentials` / `provider_memos` の行が同じ id にあるときも 400（作成すると `managed` / `keyUpdatedAt` の契約が崩れるため、先にその行を削除する）。`baseUrl` は `http` / `https` のみで userinfo・query・fragment を拒否し、末尾の `/` を落とす。`apiKey` は 8..2048 文字で、作成時は必須、更新時は空欄（未送信）なら既存を維持する。`model.contextWindow` は必須の正の整数、`model.maxTokens` は任意（既定 16384）
- カスタムプロバイダーは既存の `PUT/DELETE /api/settings/models/:provider/key` / `PUT /:provider/memo` の対象外で、これらは 400 `{ "error": "…" }` を返す（`provider_credentials` / `provider_memos` に行を作らない）。`POST /:provider/resync` はカスタム provider と削除待ちの tombstone も対象にし、DB 行 → tombstone → 通常キーの順に解決する（DB 読取失敗だけ 503 `not_stored`、復号 / 適用失敗は 200 `applied_unsynced`）
- `POST /api/settings/custom-providers/probe` は `GET {baseUrl}/models` を 1 回だけ叩き、**200 の同じ形**で成功と失敗を返す（HTTP エラーにすると分類と `httpStatus` がクライアントの汎用エラー経路へ落ちる）。body の `provider` は DB の保存済み定義を指し、`apiKey` が空欄なら保存済みのキーを復号して使う（どちらも無ければ 400）。master key 未設定 / 復号失敗は、保存を変えないため 503 `not_stored` で閉じる。`provider` が未登録・`baseUrl` が不正・キーが 8..2048 の外・body が不正なら 400。応答は `{ checkedAt, baseUrl, failure, httpStatus, models: [{ id }], truncated, message }` で、`failure === null` が成功（`message` / `httpStatus` も null）、失敗は `models: []` で `failure` が `unauthorized` / `not_found` / `http_error` / `redirected` / `invalid_response` / `timeout` / `unreachable` のいずれか。`httpStatus` は接続先の 400 以上だけ。`models` は保存検証と同じ境界を通った ID だけを重複除去・昇順で最大 200 件（超過は `truncated: true`）。**キー・応答本文・ヘッダは返さず、ログにも出さない**。設定も DB も変えないため `state` を持たず、`GET /api/settings/models` もこの通信を行わない
- `POST /api/settings/models/catalog/refresh` は body 無し。pi.dev の provider 別カタログを取り直し、キー変更と同じロックの内側で「取得 → 公開 state の再計算 → 応答の組み立て」を 1 回ずつ行う。取得と再計算は同じ期限を共有し、期限到達後は読み取りを中断して公開 state を差し替えない（一覧と available は現在値のまま。ロックも期限以上には保持しない）
- 200 の応答は `GET /api/runtime/models` と同じ形 + `catalogError`（`null` なら今回の取得成功）。一部 provider の失敗・期限の abort・取得の例外・`PI_OFFLINE` でも 200 とし、一覧は更新できた範囲（期限で中断したときは更新前）を返す。設定を変えないため `state` を持たず、カタログそのものを返せないときだけ `GET /api/runtime/models` と同じ 503 を返す。失敗しても一覧は失わせない（分類と文言の契約は [model-settings.md](model-settings.md#モデルカタログの取得と更新)）

## Web 検索の設定

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/web-search` | `enabled` / `provider`（既定）/ `providers[]`（id・名前・送信先・キーの要否・`configured`）/ `disabledMessage`。純粋読取で、行が無ければ `enabled: true` / `provider: "exa"`（既定）。APIキーの値は返さない |
| PUT | `/api/settings/web-search` | `{ enabled }`。保存した瞬間から、既存のセッションの次の `web_search` 呼び出しにも効く |
| PUT | `/api/settings/web-search/provider` | `{ provider }`。既定の provider を差し替える（`enabled` は保持）。未知の provider は 400 |
| PUT | `/api/settings/web-search/providers/:provider/key` | `{ apiKey }`。provider のキーを登録・上書き。キー不要 / 未知の provider は 400 |
| DELETE | `/api/settings/web-search/providers/:provider/key` | 行ごと削除して未設定へ戻す（冪等） |
| POST | `/api/settings/web-search/test` | `{ query }`。保存済みの設定で 1 回だけ検索し、モデルへ返る本文をそのまま返す。無効 / 検索の失敗も 200 の `ok: false` |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。変更系は 503 に `state: "not_stored"` を付け、何も保存していないことを示す。トグルの意味、provider の抽象化、失敗時の契約は [web-search.md](web-search.md) を正とする。

```json
// GET /api/settings/web-search (200。行が無い = 既定（有効 / Exa）)
{
  "enabled": true,
  "provider": "exa",
  "providers": [
    {
      "id": "exa", "name": "Exa", "host": "mcp.exa.ai", "keyless": true,
      "configured": true, "keyStored": false, "keyAvailable": true, "keyEvaluated": true, "keyErrorMessage": null
    },
    {
      "id": "tavily", "name": "Tavily", "host": "api.tavily.com", "keyless": false,
      "configured": false, "keyStored": false, "keyAvailable": false, "keyEvaluated": true, "keyErrorMessage": null
    }
  ],
  "disabledMessage": "Web 検索は無効化されています。有効にするには 設定 → Web 検索 を開いてください。"
}

// PUT /api/settings/web-search (200。変更系は GET と同じ形 + state)
{ "enabled": false, "provider": "tavily", "providers": ["…"], "disabledMessage": "…", "state": "applied" }

// PUT /api/settings/web-search (503。何も保存していない)
{ "error": "Web 検索の設定をアプリデータ（SQLite）へ保存できませんでした", "state": "not_stored" }
```

`POST /api/settings/web-search/test` は本文 `{ "query": "…" }`（trim 後 1〜500 文字、外れたら 400）。応答の `output` は
`web_search` が返す / throw する本文と同じで、`provider` は実際に送った provider（解決できなければ `null`）。
`durationMs` は所要時間、`resultCount` は出典の件数。会話にも設定にも何も保存しない。ランタイムを作れない起動は 503。

```json
// POST /api/settings/web-search/test (200。検索の失敗も 200)
{
  "ok": true,
  "output": "現在日時: 2026-02-11 (Asia/Tokyo)\n検索プロバイダー: Exa\n出典:\n[1] … — https://… (2026-02-11)\n\n…",
  "provider": { "id": "exa", "name": "Exa", "host": "mcp.exa.ai" },
  "resultCount": 5,
  "durationMs": 1234
}
```

## 会話タイトルの設定

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/session-title` | `enabled` / `model`（`provider/id` または null）/ `thinkingLevel`（保存値または null）/ `effectiveThinkingLevel`（実行時の実効値）/ `definition` / `defaultDefinition` / `models[]`（認証済みで選択できるモデルと各モデルの `thinkingLevels`）/ `modelAvailable`。純粋読取で、行が無ければ Off・モデル未選択・Effort 未指定・既定の定義 |
| POST | `/api/settings/session-title/test` | 保存済みのモデル / Effort / 定義と固定のサンプル入力で 1 回だけ生成する動作確認。結果は `{ ok, title?, error?, model?, thinkingLevel?, inputTokens?, outputTokens?, costTotal?, durationMs }` で、会話にもタイトルにも保存しない。Off / モデル未選択は生成せず `ok: false` と理由を返す。生成の失敗も 200 の `ok: false` で、pi が無い環境は 503 |
| PUT | `/api/settings/session-title` | `{ enabled, model?, thinkingLevel?, definition? }`。省略した項目は保存値を保つ（Off への変更でモデルを消さない）。On には利用可能なモデルの選択が要り、未選択・不明なモデルは 400。Effort は選択モデルが対応する段階だけを保存でき、未対応は 400。モデルを変えて Effort を省略した場合、新モデルが対応しない保存値は未指定へ戻る。空白だけ・上限超過の定義も 400 |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。変更系は 503 に `state: "not_stored"` を付ける（コンテンツ生成 / Web 検索と同じ契約）。保存済みモデルが候補から消えた場合は `modelAvailable: false` で警告し、保存値は書き換えない。実行のタイミング・試行上限・手動改名との競合は [session-title.md](session-title.md) を正とする。

```json
// GET /api/settings/session-title (200。行が無い = 既定 = Off)
{
  "enabled": false,
  "model": null,
  "thinkingLevel": null,
  "effectiveThinkingLevel": null,
  "definition": "利用者の依頼の対象と目的が伝わる会話タイトルを、日本語20〜30文字程度で作成してください。…",
  "defaultDefinition": "利用者の依頼の対象と目的が伝わる会話タイトルを、日本語20〜30文字程度で作成してください。…",
  "models": [
    { "provider": "stub", "id": "stub-model", "name": "Stub Model", "thinkingLevels": ["off", "minimal", "low", "medium", "high"] }
  ],
  "modelAvailable": false
}

// PUT /api/settings/session-title (400。On にモデルが無い)
{ "error": "AI要約を有効にするには要約モデルを選択してください" }

// PUT /api/settings/session-title (400。モデルが対応しない Effort)
{ "error": "選択したモデルではこのEffortを選べません" }
```

## コンテンツ生成

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/settings/content` | `configured` / `provider` / `enabled` / `disabledMessage` / `runtimeAvailable` / `image` / `speech` / `bgm`。画像は生成元と認証状態、画像・TTSはモデル一覧、BGMは固定モデル・形式・モデル仕様の尺を返す。純粋読取でAPIキー・トークンを返さず、生成APIも呼ばず、OAuth の解決もしない |
| PUT | `/api/settings/content` | `{ enabled }`。画像・音声・BGM 共通の有効 / 無効（キーと選択は保持。行が無ければ 400）。保存した瞬間から既存のセッションの次の呼び出しにも効く |
| PUT | `/api/settings/content/image` | `{ provider, model, parameters? }`。キーを保持したまま画像モデルの選択を更新（行が無ければ 400）。`parameters` は生成パラメータの既定で、**省略 = 据え置き / `{}` = そのモデルの既定を削除 / 値あり = 置き換え**（`model` を切り替えても他のモデルの既定は残る）。宣言外の値は 400 で保存しない（[image-generation.md](image-generation.md#画像パラメータの既定)） |
| PUT | `/api/settings/content/image/provider` | `{ provider }`（`openrouter` / `codex`）。画像の生成元だけを切り替える。キー登録を伴わないため行が無くても受け付け、`content_settings` のキー・モデル・音声・トグルは変えない（[image-generation.md](image-generation.md#画像の生成元provider)） |
| PUT | `/api/settings/content/speech` | `{ model, voice }`。キーと画像モデルを保持したまま音声モデル / ボイスを更新（行が無ければ 400） |
| PUT | `/api/settings/content/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/content/key` | 行ごと削除して未設定へ戻す（冪等） |
| POST | `/api/settings/content/image/catalog/refresh` | live カタログの再取得。常に 200 で `{ models, catalogSource, fetchedAt, catalogError }` を返す（失敗時も前の一覧を返し、`catalogError` に固定文言を載せる） |
| POST | `/api/settings/content/speech/catalog/refresh` | 音声カタログの再取得。応答は画像と同じ形 |
| POST | `/api/settings/content/trials` | `{ kind, model, prompt, voice?, instructions?, speed?, parameters?, force? }`。試行ジョブを開始し、202 で `{ trial, reused: false }`（開始直後は実行中）を返す。実行中は種別ごとに 1 本だけ（409）。`parameters` は画像の生成パラメータで、画像のときだけ受け付けてモデルの宣言と突き合わせてから provider を呼ぶ（宣言外・宣言不明・透過できない形式は 400 で課金しない）。BGM の `model` は固定値だけで、BGM の同時実行はチャットの `generate_bgm` と枠を共有する（空きが無ければ行を作らず 409）。同じ入力の保存済み成功（現在のキー世代・成果物ファイルあり）があれば provider を呼ばず 200 `{ trial, reused: true }`。`force: true` は保存済み結果を無視する。置き場のディスクの空きが 1 件分に満たないときは、行を作らず 503 `{ error, code: "disk_shortage" }` で拒否する（クレジットは消費しない） |
| GET | `/api/settings/content/trials` | `{ items, keyEpoch, artifactUsage, artifactWarning, nextBefore, hasMore }`。新しい順の履歴（`?kind=` で絞る）。`?limit=`（上限あり）と `?before=`（前のページの `nextBefore`）でページを進め、`?state=running` は実行中の行だけを返す。`items` は要約で、本文と演技指示は `GET .../trials/:id` だけが返す。送信時の `parameters` と音声の `voice` / `speed` は要約にも載る（未指定は null）ので、全文を取得しなくても再生成の入力を組み立てられる。取得のたびに `running` の取り残しと成果物の置き場を再照合する |
| GET | `/api/settings/content/trials/:id` | `{ trial }`。本文と演技指示を含む全文。終端の記録に失敗している間は `recorded: false` でメモリの状態を返す |
| GET | `/api/settings/content/trials/:id/raw` | 保存済みの成果物。`Content-Type` は保存時に確定した MIME で、`Accept-Ranges: bytes` / `X-Content-Type-Options: nosniff` / `Cache-Control: no-store`。単一の `Range` を満たすときは 206 + `Content-Range`、満たせないときは 416 + `Content-Range: bytes */<size>`（本文は JSON のエラーなので `Content-Type: application/json`。契約は [api-files.md](api-files.md#画像配信raw) と同じ）。`?download=1` で `Content-Disposition: attachment` |
| POST | `/api/settings/content/trials/:id/cancel` | 実行中の試行だけを中断して `{ trial }`。終端は 409 |
| DELETE | `/api/settings/content/trials/:id` | 終端状態の試行だけを削除し、成果物も消す。実行中は 409（`先に中断してください`） |
| DELETE | `/api/settings/content/trials` | 終端状態の試行をまとめて削除し、成果物も消す（`{ removed }`）。実行中は残る |

アプリデータの SQLite を読むため DB が使えないときは 503（[persistence.md](persistence.md#アプリデータsqlite)）。`enabled` は行が無いとき（未設定）も既定の `true` を返し、ツールの公開可否は `configured` との積で決まる。OFF の間、モデルへは `disabledMessage` の固定文言だけが返る（[image-generation.md](image-generation.md#有効化ゲート)）。モデル、保存先、ゲート、失敗分類は [image-generation.md](image-generation.md) / [speech-generation.md](speech-generation.md) / [bgm-generation.md](bgm-generation.md) を参照する。

```json
// GET /api/settings/content (200。キーは返さず、保存と利用可否だけを分けて返す)
{
  "configured": true,
  "provider": "openrouter",
  "keyStored": true,
  "keyAvailable": true,
  "keyEvaluated": true,
  "keyErrorMessage": null,
  "keyEpoch": 2,
  "enabled": true,
  "disabledMessage": "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。",
  "runtimeAvailable": true,
  "image": {
    "model": "openai/gpt-image-2",
    "provider": "openrouter",
    "auth": { "state": "configured", "kind": "api_key" },
    "models": [{ "provider": "openrouter", "id": "openai/gpt-image-2", "name": "OpenAI: GPT Image 2" }],
    "catalogSource": "live",
    "fetchedAt": 1740000000000,
    "parametersByModel": { "openai/gpt-image-2": { "aspect_ratio": "16:9" } }
  },
  "speech": {
    "model": "google/gemini-3.8-flash-tts",
    "voice": "Zephyr",
    "models": [
      { "provider": "openrouter", "id": "google/gemini-3.8-flash-tts", "name": "Google: Gemini 3.8 Flash TTS", "voices": ["Zephyr", "Kore"] }
    ],
    "catalogSource": "live",
    "fetchedAt": 1740000000000
  },
  "bgm": {
    "model": "google/lyria-3-clip-preview",
    "format": "mp3",
    "expectedDurationSeconds": 30
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

- `configured` は `content_settings` に行があるか。`false` のとき `provider` / `image.model` / `speech.model` / `bgm.model` は `null`（行が無い = 未設定）。
- `image` / `speech` / `bgm` は兄弟の表示項目。`bgm` は `{ model, format, expectedDurationSeconds }` で形式と尺は固定のモデル仕様（生成物の実測値ではない）。値とDTOの正は `server/src/bgm.ts` / `server/src/schema.ts`。BGM専用の保存APIは追加せず、変更系もGETと同じbgmを返す（[bgm-generation.md](bgm-generation.md)）。
- `image.provider` は画像の生成元（`openrouter` / `codex`。行が無ければ既定の `openrouter`）で、`image.auth` は選択中の provider の認証状態（`configured` / `missing` / `expired` と `kind`）だけを返す。**GET はどちらも保存値の読取だけで判定し、OAuth のトークン解決・更新・外部通信をしない**。`image.models` は OpenRouter を選んでいるときだけ返し、Codex のときは空配列（画像モデルを選ばない。ルーティングモデルを画像モデルとして返さない）。
- `image.models` は live カタログ（OpenRouter の画像モデル API）で、UI はこの一覧からだけモデルを選べる。各要素は `provider` / `id` / `name` と、宣言があるときだけ `parameters`（生成パラメータの宣言）を持つ。`image.parametersByModel` は保存済みの生成パラメータの既定（bare なモデル id → 値）で、**各エントリをそのモデルの宣言で絞る**。宣言が読めないモデルのエントリは空になる（[image-generation.md](image-generation.md#画像パラメータの既定)）。`catalogSource` は `live` / `stored` / `sdk` で、`live` 以外は取得に失敗した状態（`stored` = 前回の成功を DB キャッシュから、`sdk` = SDK 同梱）を表し、`fetchedAt` は最後に live を取得できた時刻（`sdk` は `null`）。キー値はどの応答にも含めない（[image-generation.md](image-generation.md#モデルカタログ)）
- `speech.models` は live カタログ（OpenRouter の音声モデル一覧 API）で、`voices` に話者の宣言を含む。`catalogSource` は `live` / `stored` / `default` で、`default` は「live もキャッシュも無く、同梱の既定 1 件を見ている」を表す。`voice` の空文字は「指定なし」（宣言が無いモデルで送らない）。`content_settings` の音声列が `NULL` の既存行は、既定モデルと先頭ボイスへフォールバックして返す（[speech-generation.md](speech-generation.md#モデルカタログ)）
- `runtimeAvailable` は `/api/settings/models` と同じく「SDK ランタイムの初期化に成功したか」。`false` のときキー登録は 503 `not_stored`（`retainSecret` が no-op になり保護できないため）。選択変更と削除は runtime に依存しない
- POST の `catalogError` は**今回の取得だけ**の結果で、`null` なら成功。失敗しても一覧と `catalogSource` は前のままで、503 にはしない（設定ではなくキャッシュの更新なので `state` も付けない）
- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映を持たないため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- 400: 行が無いのに PUT（`コンテンツ生成のAPIキーが未設定です。先にキーを登録してください`）、`openrouter` 以外の provider、画像の生成元が `openrouter` / `codex` 以外、カタログ外の model、宣言外の画像パラメータ（宣言に無いキー・宣言の外の値・宣言が読めないモデルへの値）、画像 / 音声のカタログ外モデル、宣言があるモデルで宣言外のボイス、8..2048 文字外のキー、形が違う本文。音声カタログが `default` のときはカタログ照合をしない（[speech-generation.md](speech-generation.md#モデルカタログ)）。BGM 専用の設定は持たず、試行の `model` は固定値だけを受け付ける（[bgm-generation.md](bgm-generation.md#試行設定画面)）
- `keyEpoch` はキーの世代で、**上書きと（行があったときの）削除で進む**。新規保存と未設定の削除では動かさない。試行の証拠は「現在の `keyEpoch` と現在のモデル」に一致する成功だけを数えるため、旧キーの実績が現在のキーの確認として扱われない（[image-generation.md](image-generation.md#設定画面)）
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`。削除すると行ごと消え、`generate_image` / `generate_speech` / `generate_bgm` は次のセッション作成・復元から公開されなくなる（既存liveセッションの execute は実行時にキー無効エラーを返す）。

音声の生成は試行（`POST /api/settings/content/trials` の `kind: "speech"`）に一本化し、設定を変えない別の生成ルートは持たない（旧 `/api/settings/content/speech/preview` は退役した）。本文・演技指示・話速は試行の入力スナップショットとして履歴に残り、成果物は同じ raw ルートで配信する。

```json
// POST /api/settings/content/trials (202。BGM。モデルは固定で、入力は prompt だけ)
{
  "trial": {
    "id": "trial-0123456789abcdef01234567",
    "kind": "bgm",
    "model": "google/lyria-3-clip-preview",
    "prompt": "夜の高速道路を走る軽快なシンセポップ",
    "voice": null,
    "instructions": null,
    "speed": null,
    "state": "running",
    "keyEpoch": 2,
    "artifactState": "none",
    "artifact": null,
    "charged": false,
    "failureCode": null,
    "failureMessage": null,
    "startedAt": 1740000000000,
    "finishedAt": null,
    "durationMs": null,
    "recorded": true
  },
  "reused": false
}
```

```json
// POST /api/settings/content/trials (202。音声。実行中は種別ごとに 1 本だけ)
{
  "trial": {
    "id": "trial-0123456789abcdef01234567",
    "kind": "speech",
    "model": "google/gemini-3.8-flash-tts",
    "prompt": "おはようございます",
    "voice": "Aoede",
    "instructions": null,
    "speed": 1.1,
    "state": "running",
    "keyEpoch": 2,
    "artifactState": "none",
    "artifact": null,
    "charged": false,
    "failureCode": null,
    "failureMessage": null,
    "startedAt": 1740000000000,
    "finishedAt": null,
    "durationMs": null,
    "recorded": true
  },
  "reused": false
}

// POST /api/settings/content/trials (400。音声の課金前の検証。provider は叩かない)
{ "error": "話速は 0 より大きい数値で指定してください（クレジットは消費していません）" }
```

### 試行ジョブ

設定に反映しない試行（動作確認）は、画面の寿命に縛らないジョブとして持つ。実装の正は `server/src/content-trials.ts` と `server/src/content-trial-artifacts.ts`、状態の一覧・期限・再照合の間隔・形式の許可リストはそこから読む。

- 開始は 202 で、状態は `GET .../trials/:id` と一覧で取る。**リクエストの `AbortSignal` には結び付けない**（画面を離れても続く）。中断は明示キャンセルと BFF の close だけで、close は実行中の試行を abort する
- 種別ごとに同時 1 本。実行中は開始が 409。**キャンセルしても provider の呼び出しが終わるまで次の試行を始められない**（終端を決めた後の結果は捨てる）
- 終端状態は不変で、`running` の行だけが終端へ進む（DB の更新条件も同じ）。キャンセルは `running` のときだけ受け付け、完了後のキャンセルは 409 で状態を戻さない
- 失敗は既存の provider 失敗分類をそのまま載せ、自動では再試行しない。APIキーは行にも応答にもログにも残さず、キーの世代（`keyEpoch`）だけを持つ
- 再起動でレジストリを失った `running` は `interrupted` に倒す（再開しない）。一覧の取得時にも、期限を過ぎてレジストリに無い行だけを同じ扱いにする（間引きあり）。再照合と実行中の取得は `running` の行だけを DB から読み、履歴の全件を走査しない
- 一覧は**要約**（本文は抜粋の `promptPreview`、演技指示は載せない）を新しい順で返し、`limit`（上限あり）と `before`（前のページの `nextBefore`）でページを進める。カーソルは不透明で、行の削除で位置がずれないよう行の値（開始時刻と rowid）から作る。範囲外の `limit` と解釈できない `before` は空の成功にせず 400、`state` は `running` だけを受ける。全文が要るのは選択行と、履歴の行から再実行・入力欄へ戻す操作で、そのときだけ `GET .../trials/:id` を引く
- **実行中は `?state=running` の行（と選択行の全文）だけを取りに行き**、一覧のページを再度取らない。実行中だった行がその応答から消えたら終端した（または削除された）とみなし、その行だけ `GET .../trials/:id` で確定させる（要約のままだと実行中のまま残る）。一覧の取得ではこの確定を行わない（ページ外の古い行を巻き込まない）
- この確定は **404 のときだけ「行が消えた」とみなし**、通信断や 5xx の失敗は「まだ分からない」として行を一覧に残し、次のポーリングで取り直す。失敗を終端や削除として扱うと、実行中の行が一覧から消えてポーリングまで止まり、サーバー側で完了しても再読み込みするまで結果が出ない
- 終端を DB へ書けなかったときは、メモリの終端を `recorded: false` として返し、次の取得で記録を再試行する
- 成果物はアプリデータ領域の兄弟 `<storeDir>/trials` に `<trialId>.<ext>` で置き（`server/src/content-trial-artifacts.ts`）、行には相対名・バイト数・形式・寸法だけを持つ。`generated/` にもプロジェクトにも DB の BLOB にも置かず、サンドボックスを要求しない
- 保存できる形式は種別ごとに固定する。画像は png / jpeg / webp で、宣言 MIME と実バイトの両方を `saveableImageFormat` の許可リストに通し、実バイトの形式を正にする。音声は mp3 / wav で、宣言 MIME と実バイト（RIFF/WAVE・mp3 のフレーム同期 / ID3）を見る。pcm の応答は生成器と同じ関数で RIFF を付けて wav にする。BGM は生成器が形式を宣言せずバイトだけを返すため、宣言 MIME は固定の `audio/mpeg` とし、実バイトが MP3 として読めるものだけを保存する（wav は通さない）。svg / html / 不明な MIME / 宣言と実体のずれは**保存の前に**拒否する
- 生成が成功して成果物を保存し、終端を `succeeded` として記録できたときだけ成功とする。保存に失敗したら分類 `storage`（課金済み）の `failed` にして成功として見せない。終端を記録できなかった成果物は消し、メモリの失敗（`failed` / `storage`）を `recorded: false` で返す
- 同じ入力の保存済み成功があり、現在のキー世代で成果物ファイルが残っているときは provider を呼ばず 200 `{ trial, reused: true }` を返す（課金せず、新しい成功としても記録しない）。入力は画像が「種別 / 生成元 / モデル / プロンプト / 画像のパラメータ」、BGM が「種別 / モデル / プロンプト」、音声が「種別 / モデル / 本文 / ボイス / 演技指示 / 話速」で、音声の 3 つと画像のパラメータは NULL（未指定）同士も一致として扱う。`force: true` はこの再利用をせず、履歴の [もう一度生成] だけが送る
- 画像の生成パラメータは画像の試行だけが受け付け（音声 / BGM に付いていたら 400）、宣言と突き合わせてから provider を呼ぶ。**正規化（許可リストのキーだけ・未指定は載せない・キー順固定）した JSON を行のスナップショットにし、再利用の照合にもその値を使う**（表示用の別列は作らない。同じ正規化から 2 列を作ると片方だけ更新する余地ができる）。正規化の規則を変えると旧い行の再利用が外れるだけで、壊れはしない。宣言が読めないモデルでは明示のパラメータを受けない（既定が無いので「落とす」対象も無い）。`background: "transparent"` は実効の `output_format` が png / webp のときだけ通し、`output_format` を省略しても宣言に png / webp が無ければ止める（宣言から読めないときは通す）。壊れた保存値は未指定へ落とさず、503 / 行の破損として見せる（[persistence.md](persistence.md#アプリデータsqlite)）
- 音声の入力（本文・ボイス・演技指示・話速）は行のスナップショットとして履歴に残し、同じ入力の照合にも使う。課金前の検証はカタログのモデル、宣言があるモデルのボイス、本文と演技指示の長さ、正の `speed`
- BGM は入力が prompt と固定モデルだけで、音声の 3 列は null。モデルが固定値（`BGM_MODEL`）でないときは 400。**BGM の同時実行はチャットの `generate_bgm` と同じプロセス内の枠（`BGM_MAX_CONCURRENT`）を共有し、試行用の別枠を足さない**ので、チャットで 2 本走っている間は試行を開始できず、逆も同じ（枠が無いときは行を作らず 409）。期限は `BGM_TIMEOUT_MS` を provider の呼び出しだけに掛け、失敗は `provider-failure` の分類へ写す（[bgm-generation.md](bgm-generation.md#試行設定画面)）
- モデルを受け付けない 400 の文言は種別ごとに変える（画像は「カタログに無い画像モデル…」、音声は「カタログに無い音声モデル…」、BGM は「BGMのモデルは固定です…」）。画像の文言を他の種別へ出さない
- 配信は trial id だけの同 origin ルートで、保存時に確定した MIME（画像は `image/*`、音声は `audio/mpeg` / `audio/wav`）・`nosniff`・`no-store` を付け、`?download=1` のときだけ添付にする。パスは受け取らず、保存名が行の id と形式から作り直した名前と一致しない行と、種別の許可リストに無い形式の行は配信しない
- 配信はファイル配信と同じ**単一 `Range`** の契約に従う（200 に `Accept-Ranges: bytes`、`bytes=<start>-<end>` / `bytes=<start>-` / `bytes=-<suffix>` は 206 + `Content-Range` + 部分の `Content-Length`、満たせない範囲は 416 + `Content-Range: bytes */<size>`、解釈できない `Range` と複数レンジは無視して 200）。音声のシークは全体を読み終えるまで待たせない
- 置き場の再照合は、`succeeded` + `stored` の行のファイルだけを残し、それ以外の行にひも付くファイルと行の無いファイルを消す。起動時（レジストリは空）は全件を、一覧の取得時は間引いて同じ規則を適用する。ただし実行中レジストリに居る trial（保存後・終端更新前を含む）のファイルは消さない
- 再照合は**ファイル一覧を取った後に行一覧を読み**、削除の直前にもその行を読み直す。一覧の取得を待つ間にジョブが `succeeded` + `stored` へ確定してレジストリから外れるため、先に読んだ行一覧で残す対象を決めると、確定済みのファイルを中途ファイルとして消してしまう（配信 404・画像の無い成功の再利用・容量の数え残しになる）
- 保存容量はディレクトリを走査せず、`succeeded` + `stored` の行のバイト数を合計する（`artifactUsage`）。時間ベースの自動削除はしない
- 保存容量の警告は server の定数（`server/src/content-trial-artifacts.ts`）で判定し、一覧の `artifactWarning` に**しきい値と警告かどうかだけ**を載せる。しきい値の値と比べ方の正はそこだけで、画面は応答の `thresholdBytes` をそのまま使って文言・色・表示位置を決める（client にしきい値を持たない。`artifactWarning` を返さない応答では警告しない）。消すかどうかも画面と利用者が決め、server は自動削除しない
- 生成の前に置き場の空きを見て、1 件分の上限に余白を足した分に満たないときは**行を作らずに開始を拒否する**（`server/src/content-trial-disk-space.ts`、503 `{ error, code: "disk_shortage" }`。クレジットは消費していない）。空きは `<storeDir>/trials` を `fs/promises` の `statfs` で読み、置き場がまだ無いときは作られる親を見る（どちらも読み口は依存として注入し、テストは固定値を渡す）
- **開始拒否と `storage` の終端失敗は意味が違う。** 開始拒否は行も課金も作らない 503 で、`failureCode` を持たない。`failureCode: "storage"` は生成が成功した後に保存できなかった `failed`（`charged: true`）で、再試行は再課金になる。どちらも「保存先の問題」だが、利用者に課金の有無を伝える文言を混ぜない。画面は開始の拒否を応答の `code` で分類し（`client/src/api.ts` が `ApiError.code` に載せる）、空き不足だけを行も課金も作らない拒否として、他の開始失敗（409 の同時実行・400 系）とは別の文言で出す。分類と文言は `client/src/lib/contentTrials.ts` の純関数が持つ
- 空き不足は**再利用（同じ入力の保存済み成功、200）を阻害しない**（provider を呼ばず課金もしないため）。`force: true`（履歴の [もう一度生成]）は新しい保存が要るため、空きが足りなければ 409 や再利用ではなく開始拒否になる
- 空きを測れない環境（`statfs` の非対応・権限の失敗）は**通過に倒す**。測れないことを理由に正しい試行まで止めない（保存できなければ従来どおり `storage` の失敗になる）

`configured`（設定行の有無）と `keyStored`（暗号文の有無）・`keyAvailable`（復号できて生成ツールへ渡せる）・`keyEvaluated` / `keyErrorMessage` は別の軸で、実効の公開ゲートは「行がある」「`enabled`」「`keyAvailable`」の積。`configured: true` / `keyStored: true` / `keyAvailable: false` でも画面はキーの削除・置換を出す。未評価（runtime 無し / 起動時に DB を読めなかった）は `keyEvaluated: false` と「まだ確認できていない」固定文言で、誤鍵・破損と断定しない（[secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url)）。

## 作業フォルダの環境変数

作業フォルダ（cwd）単位の名前と値。種別は平文で保存する `variable` と、AEAD で暗号化する `secret`。設計（名前 / 値の規則、注入経路、保証範囲）は [secrets.md](secrets.md#作業フォルダの環境変数) を正とする。

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/api/secrets?sessionId=<id>` / `?projectId=<id>` | 一覧（名前・種別・更新時刻・世代・プロジェクト所属か） |
| POST | `/api/secrets` | 登録（body: `{ sessionId? , projectId?, kind, name, value }`） |
| GET | `/api/secrets/:secretId?sessionId=<id>` | 値の表示 / 変更フォーム用の 1 件（`value` は**変数のときだけ**入る） |
| PUT | `/api/secrets/:secretId` | 値の上書き（body: `{ sessionId?, projectId?, value }`。名前と種別は変えられない） |
| PATCH | `/api/secrets/order` | 表示順の保存（body: `{ sessionId?, projectId?, ids }`。応答は並べ替え後の一覧） |
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

- **シークレットの値はどの応答にも載らない。** 値の表示 / 変更フォーム用の `GET /api/secrets/:secretId` だけが `value` を持ち、それも変数のときだけ
- `PATCH /api/secrets/order` は渡された順に `sortOrder` を 1..n へ振り直す。**未知の id・重複・別 cwd の id は捨て、渡されなかった行は元の相対順で末尾へ回す**（`[]` は現行順のまま）ので、並べ替えで行を消さない。応答は `GET /api/secrets` と同じ形で、値は載らない。400 = 本文が不正（`ids` の欠落・配列でない・文字列以外を含む・件数上限超過）、503 = DB 障害
- `generation` は変更のたびに変わる短いハッシュ（名前 → `secret_id` / 更新世代）。`GET /api/serve/status` の `secretGeneration` と比べると「再起動で反映される変更がある」と分かる（UI は一覧上部の凡例まで）。並べ替えは名前・`secret_id`・更新時刻を変えないため、世代も変えない
- `projectScoped` は cwd が登録プロジェクトのディレクトリか（UI の「このプロジェクトの設定です」の根拠）
- 変更系は 200 で `{ item, trimmed, generation }` を返す（`trimmed` は前後の空白 / 改行を除去したか。削除は `{ removed, generation }`）

エラー: 名前 / 値の規則違反は 400、同名の重複は 409、別の cwd / 存在しない `secretId` は 404、シークレットで master key が未設定 / 宣言が壊れている / 復号できないときは 503（`state: "not_stored"`）。アプリデータが使えないときも 503（変更系は `state: "not_stored"`）。
