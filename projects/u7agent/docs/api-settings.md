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
| GET | `/api/settings/content` | `configured` / `provider` / `enabled` / `disabledMessage` / `runtimeAvailable` / `image` / `speech` / `bgm`。画像・TTSはモデル一覧、BGMは固定モデル・形式・モデル仕様の尺を返す。純粋読取でAPIキーは返さず、生成APIも呼ばない |
| PUT | `/api/settings/content` | `{ enabled }`。画像・音声・BGM 共通の有効 / 無効（キーと選択は保持。行が無ければ 400）。保存した瞬間から既存のセッションの次の呼び出しにも効く |
| PUT | `/api/settings/content/image` | `{ provider, model }`。キーを保持したまま画像モデルの選択を更新（行が無ければ 400） |
| PUT | `/api/settings/content/speech` | `{ model, voice }`。キーと画像モデルを保持したまま音声モデル / ボイスを更新（行が無ければ 400） |
| POST | `/api/settings/content/speech/preview` | `{ model, voice, text, instructions?, speed? }`。音声のお試し再生（[speech-generation.md](speech-generation.md#お試し再生パラメーターのプレイグラウンド)）。成功は音声バイト、失敗は `{ error, code? }` |
| PUT | `/api/settings/content/key` | `{ apiKey }`。登録・上書き（行が無ければ既定 provider / model で作成） |
| DELETE | `/api/settings/content/key` | 行ごと削除して未設定へ戻す（冪等） |
| POST | `/api/settings/content/image/catalog/refresh` | live カタログの再取得。常に 200 で `{ models, catalogSource, fetchedAt, catalogError }` を返す（失敗時も前の一覧を返し、`catalogError` に固定文言を載せる） |
| POST | `/api/settings/content/speech/catalog/refresh` | 音声カタログの再取得。応答は画像と同じ形 |

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
  "enabled": true,
  "disabledMessage": "コンテンツ生成は無効化されています。有効にするには 設定 → コンテンツ生成 を開いてください。",
  "runtimeAvailable": true,
  "image": {
    "model": "openai/gpt-image-2",
    "models": [{ "provider": "openrouter", "id": "openai/gpt-image-2", "name": "OpenAI: GPT Image 2" }],
    "catalogSource": "live",
    "fetchedAt": 1740000000000
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
- `image.models` は live カタログ（OpenRouter の画像モデル API）で、UI はこの一覧からだけモデルを選べる。`catalogSource` は `live` / `stored` / `sdk` で、`live` 以外は取得に失敗した状態（`stored` = 前回の成功を DB キャッシュから、`sdk` = SDK 同梱）を表し、`fetchedAt` は最後に live を取得できた時刻（`sdk` は `null`）。キー値はどの応答にも含めない（[image-generation.md](image-generation.md#モデルカタログ)）
- `speech.models` は live カタログ（OpenRouter の音声モデル一覧 API）で、`voices` に話者の宣言を含む。`catalogSource` は `live` / `stored` / `default` で、`default` は「live もキャッシュも無く、同梱の既定 1 件を見ている」を表す。`voice` の空文字は「指定なし」（宣言が無いモデルで送らない）。`content_settings` の音声列が `NULL` の既存行は、既定モデルと先頭ボイスへフォールバックして返す（[speech-generation.md](speech-generation.md#モデルカタログ)）
- `runtimeAvailable` は `/api/settings/models` と同じく「SDK ランタイムの初期化に成功したか」。`false` のときキー登録は 503 `not_stored`（`retainSecret` が no-op になり保護できないため）。選択変更と削除は runtime に依存しない
- POST の `catalogError` は**今回の取得だけ**の結果で、`null` なら成功。失敗しても一覧と `catalogSource` は前のままで、503 にはしない（設定ではなくキャッシュの更新なので `state` も付けない）
- 変更系の応答は GET と同じ形 + `state: "applied"`。SDK への反映を持たないため `applied_unsynced` は無い。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`
- 400: 行が無いのに PUT（`コンテンツ生成のAPIキーが未設定です。先にキーを登録してください`）、`openrouter` 以外の provider、カタログ外の model、画像 / 音声のカタログ外モデル、宣言があるモデルで宣言外のボイス、8..2048 文字外のキー、形が違う本文。音声カタログが `default` のときはカタログ照合をしない（[speech-generation.md](speech-generation.md#モデルカタログ)）
- キー登録の既定は provider `openrouter` / model `openai/gpt-image-2`。削除すると行ごと消え、`generate_image` / `generate_speech` / `generate_bgm` は次のセッション作成・復元から公開されなくなる（既存liveセッションの execute は実行時にキー無効エラーを返す）。

`preview` は設定を変えないため `state` を付けず、`appData`（DB ゲート）だけを通す。成功の応答は音声バイト（mp3 は `Content-Type: audio/mpeg`、pcm は RIFF ヘッダを付けて `audio/wav`）で、`X-Content-Type-Options: nosniff` と `Cache-Control: no-store` を付ける。失敗は JSON なので、判別は status と Content-Type で行う。

```json
// POST /api/settings/content/speech/preview (400。行なし、または課金前の検証で止めた。文言は理由ごとに固定)
{ "error": "…" }

// POST /api/settings/content/speech/preview (502。provider の失敗を分類して返す)
{ "error": "音声生成に失敗しました: <マスク済みの provider メッセージ>", "code": "unknown" }

// POST /api/settings/content/speech/preview (503。runtime 不可 / DB 不通)
{ "error": "…" }
```

- 502 の `code` は `invalid_key` / `insufficient_credit` / `rate_limited` / `timeout` / `aborted` / `unknown` で、正は `server/src/provider-failure.ts`（[speech-generation.md](speech-generation.md#失敗の分類)）
- 課金前の検証（行なし / カタログ外モデル / 宣言外ボイス / 本文と `instructions` の長さ / 空本文 / `speed` の型）は provider を叩かず 400 にする。文言は「クレジットを消費していない」ことを伝えるプレビュー用のものを返す（分割を促すツール向け文言は使わない）。`speed` の範囲は provider の制約なのでアプリでは縛らない

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
