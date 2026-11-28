# Codex との連携（資格情報・サインイン・送信）

- Status: accepted
- Date: 2026-11-23

## 背景

Codex の利用枠を読むには ChatGPT の OAuth access token と `chatgpt-account-id` が要る。token は refresh token で
更新され、refresh token はローテーションする。ホストの Pi（`~/.pi/agent/auth.json`）や u7agent の agent dir を
共有すると、2 プロセスが同じ refresh token を更新して片方の認証が壊れる。また、5 時間の利用枠は前の窓が
終わったあとの最初のメッセージで始まるため、開始を意図的に選ぶ手段も要る。

## 決定

### 資格情報

- 資格情報は Portal 専用の `CREDENTIAL_DIR`（既定 `/app/credentials`）に置き、ホストの Pi や u7agent とは共有しない。
- OAuth は実装しない。Pi SDK（`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`）の `ModelRuntime` を
  資格情報の読み取り・更新・サインインだけに使い、agent session は作らない。
- `ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })` を 1 つだけ作る。
  model catalog の保存もネットワーク更新もしない。
- access token は `getAuth("openai-codex", { minOAuthValidityMs: 15 分 })` から、`accountId` は
  `readStoredCredential` から取る。どちらも応答・DB・ログには出さない（accountId は履歴のキーにだけ使う）。
- device id は `CREDENTIAL_DIR/device-id` に UUID で保存し、`ModelRuntime.login` の `getDeviceId` と
  `agentName: "usage-portal"` に渡す。
- SDK を扱うパッケージは u7agent と同じバージョンに固定し、Dependabot の自動更新対象から外す。
  マイナーでも破壊変更が入る前提で、更新時は認証の経路を確認する。
- `CREDENTIAL_DIR` は起動時に 0700、`auth.json` / `device-id` は 0600 に揃える。揃えられなければ起動しない。

### サインイン

- サインインは `ModelRuntime.login("openai-codex", "oauth", interaction)` を BFF のメモリ上の状態機械で包む。
  `select` は選択肢を出し（既定はデバイスコード）、`auth_url` / `device_code` / `progress` だけを受け付ける
  （`info` は無視）。`text` / `secret` は「この画面では扱えない方式」として失敗させる。
- `manual_code` は待機中のときだけ受け付け、`prompt.signal` が abort されたら入力欄を閉じ、以後の送信は 400 にする。
- 進行中の二重開始は 409。中断は冪等。開始から 10 分で自動中断してコールバック待受を解放する。
- サインイン成功時は sampler を 1 回走らせ、その完了を待ってから `succeeded` を公開する。
- SDK が投げる `CredentialSynchronizationError` は、`providerId === "openai-codex"` かつ operation が
  login / logout と一致する場合だけ成功として扱う（`auth.json` への保存は済んでいるため）。
- 1455 は publish しない。ブラウザのコールバックはコンテナ内の `127.0.0.1` に閉じるため、スマホはデバイスコード、
  PC は貼り付けで完了できるようにしてある。
- サインアウトは `auth.json` の資格情報を消すだけで、provider 側の接続は失効させない（解除は ChatGPT の設定から行う）。

### 上流 API

- 利用枠は `GET https://chatgpt.com/backend-api/wham/usage` を `Authorization: Bearer <access>` と
  `chatgpt-account-id: <accountId>` で読む。公開契約ではないため、変更されたら adapter を直す。
- `primary_window` / `secondary_window` は `null` を許容する。返ってきた窓だけを表示する。
- `reset_at`（epoch 秒）を優先し、無ければ取得時刻 + `reset_after_seconds` を使う。
- `rate_limit.limit_reached` が true、または `allowed` が false なら上限到達として扱う。
- リセット枠の回数は `rate_limit_reset_credits.available_count` から読む。期限は usage に含まれないため、
  `available_count > 0` のときだけ `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` を追加で読み、
  `credits[]`（`status` が `available`）の `expires_at`（RFC3339、`null` は期限なし）を全部、昇順で使う。
- 期限の取得は CLI と同じ best-effort とする。5 秒で諦め、失敗・形の変化は snapshot 全体を落とさず、
  回数だけの表示に戻す。期限を推測して出さない（取得できていないことを「期限なし」と書かない）。
- 詳細 API の一覧は `available_count` より短いことがある。見えている枠の期限を全部出し、残りは期限不明として扱う。
- クレジット残高は `credits.balance`（文字列）を数値に丸めて注記する。`unlimited` は「無制限」、
  数値を読めないときは `has_credits` の有無だけを注記する。
- `email`、`user_id`、上流の生 JSON は保存しない。リセット枠は回数と期限の一覧だけを snapshot に残す。
- device code / OAuth の callback はコンテナ内に閉じるため、スマホからはデバイスコードで承認する。

### 最小プロンプトの送信

- 送信は pi-ai の provider adapter（`openaiCodexProvider()`）を直接使う。エージェントは使わず、
  system prompt・tools・会話履歴もアプリからは足さない。プロンプトはサーバ側の固定 1 文
  （`Reply with the single word OK.`）だけで、利用者の入力を混ぜない。
- 認証の境界は上記のまま。`CodexAuth.credential()` が返す access token を adapter に渡し、
  `auth.json` を独自に解析しない。
- モデルと思考レベルはコードに既定値を置かず、`DATA_DIR/settings.json` に保存する。未設定のあいだ送信の入口を出さない。
  正は `GET /api/probe/models` が返す catalog（pi-ai 同梱の `getModels()`）とし、保存時と送信時の両方で照合する。
- HTTP status は adapter の `onResponse` ではなく、request-local の `fetch` wrapper で控える。
- 成功は HTTP 200 では決めない。stream を最後まで消費し、`result()` の `stopReason` が `error` / `aborted` でないことを
  確かめる。`length` は probe としては成功とする。
- 上限は `AbortSignal.timeout(30_000)` を adapter に渡して stream 全体に掛ける。`finally` で source ごとの
  single-flight を必ず解放する。
- 失敗は固定のコードへ丸める。401 / 403 は `reauth_required`、429 は `limit_reached`、400 / 404 は
  `model_unavailable`、それ以外と stream の異常終了は `unavailable`。上流の本文・`errorMessage` は返さない・
  ログに出さない。
- 送信後は `sampler.kick()` を試すが、その完了はリセット時刻の更新を意味しない。取得できたときだけリセット時刻を出し、
  反映遅れを失敗として扱わない。
- 5 時間窓が API に出ないアカウントがあるため、「開始済み」の判定は持たない。送信後も利用枠に現れないことがある。

## 採用しない案

- ホストの `~/.pi/agent/auth.json` を共有する: refresh token の更新が競合し、片方の認証が壊れる。
- OAuth を自前実装する: PKCE、callback server、device code、refresh、ローテーションの保守を抱える。
- CLI サインインを前提にする: スマホから `codex login` を実行できず、コンテナ内のコールバックもホストから届かない。
- token を `.env` や DB に置く: 期限付きでローテーションする値なので、ファイル 1 つ（0600）に閉じる方が事故が少ない。
- 送信を `ModelRuntime` 経由にする: 認証の境界として作ったもので、送信の status や stream の終端を扱えない。
- 開始済みを `usedPercent` で判定する: 5 時間窓が返らないアカウントでは週次の値を見ることになる。
- 上流の本文や `errorMessage` を画面に出す: 何が返るか分からない文面を LAN 内の画面へ流す理由がない。

## 影響

- final image は SDK と CLI のぶん大きくなる。認証の再実装より保守性を優先する。
- probe の対象は OpenAI-compatible / OpenAI Responses / Anthropic Messages / Codex Responses の adapter に限る。
  Google の adapter は custom fetch を受け付けず status を捕捉できないため対象外。
- `DATA_DIR/settings.json` は秘密ではないが、他と同じ 0600・atomic write にする。壊れたファイルは「未設定」として扱い、
  警告を 1 回だけ出して fallback しない。
- Codex adapter は `maxTokens` を body に載せない。出力は `textVerbosity` の既定 low と短いプロンプトで抑える。
- `wham/usage` と Sign in with ChatGPT の応答形式は予告なく変わり得る。fixture を固定し、SDK の版を上げるときに差分を見る。
