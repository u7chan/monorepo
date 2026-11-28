# usage-portal

Codex（ChatGPT サブスクリプション）・OpenCode Go・Claude（Pro / Max）・Gemini（Google AI / Antigravity）の利用枠を 1 ページで確認するダッシュボード。
自宅 LAN または VPN の内側から、スマホと PC で見る画面で、Docker コンテナとして動かす。
利用枠の表示に加えて、設定したときだけ最小プロンプトを 1 回送る操作（Codex の 5 時間窓の開始と
OpenCode Go の接続確認）を持つ。

全体設計は [docs/design.md](docs/design.md)、決定の理由は [docs/adr/](docs/adr) を参照する。

## 機能

- Bun + TypeScript + Preact + Hono。CSS トークンは `--up-` 接頭辞で、`prefers-color-scheme` に追従する
- 初回アクセスの PIN 登録、PIN ログイン、署名付きセッション cookie（30 日）、試行制限、期限バナー
- BFF が provider ごとの間隔（既定 10 分、5 / 10 / 30 / 60 / 120 分から選ぶ）で Codex と OpenCode Go の利用枠を取り、SQLite に snapshot と sample を保存する
- 画面は 60 秒ごとに `/api/usage` を取得する。推移は窓ごとに描き、ローリング・週次・月次をタブで切り替える
- 取得間隔は provider ごとに 5 / 10 / 30 / 60 / 120 分から選べる（既定 10 分、`⋮` の「取得間隔」）
- 表示は「簡易」と「標準」を切り替えられる。簡易は推移と補足を省いて 3 件程度を 1 画面に収め、選択は localStorage に残す
- 窓は月次 ⊃ 週次 ⊃ ローリングの入れ子で、外側が上限なら内側は「使用不可」と赤で出す（[docs/adr/usage-sampling-and-storage.md](docs/adr/usage-sampling-and-storage.md)）
- Codex は Web UI から Sign in with ChatGPT（デバイスコード / ブラウザ + 貼り付け）でサインインする
- Claude は公式 `claude` CLI の `/usage` を子プロセスで実行し、画面を開いたときと `⋮` の「更新」だけ取得する。
  開きっぱなしでも周期取得せず、取得から 15 分を過ぎたら「更新停止」と出す（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）
- Claude のカードは認証済みのときだけ出し、未接続のあいだは全体メニューの「Claude」から手順と「接続を確認」を開く。
  カードの `⋮` の「ログアウトして非表示」は公式 CLI で資格情報を破棄してカードを消す（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）
- Claude のサインインは Web UI で中継しない。初回は端末から `docker exec -it <コンテナ名> claude auth login` を実行する
- Gemini は公式 `agy`（Antigravity CLI）の `/usage` を子プロセスで実行し、Claude と同じく画面を開いたときと `⋮` の「更新」だけ取得する。
  読むのは Antigravity の Gemini Models の週次・5 時間の枠だけで、Gemini アプリ・Gemini CLI の上限ではない。
  接続の判定は `agy models`、サインインは端末から `docker exec -it -e HOME=/app/credentials/antigravity <コンテナ名> agy`
  （[docs/adr/gemini-integration.md](docs/adr/gemini-integration.md)）
- Gemini のカードも認証済みのときだけ出し、未接続のあいだは全体メニューの「Gemini」から手順と「接続を確認」を開く。
  カードの `⋮` の「ログアウトして非表示」は token を読まずに削除し、`agy models` で未接続を確かめてからカードを消す
- Claude のカードの `⋮` の「開始予約…」で、5 時間窓を開始する時刻を予約できる。「必ずリセットさせる時刻」と 1 日の回数から、
  5 時間おきの開始と、窓を始めない空き（既定は深夜）を決める。送る前に `/usage` で窓が動いていないことを確かめ、
  3 回続けて失敗したら自動でオフにする。「今すぐ開始」で 1 回だけ送ることもできる（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）
- 送信の設定（モデルと思考レベル）を済ませると、Codex と OpenCode Go のカードの `⋮` に「接続確認」が出る。
  固定の最小プロンプトを 1 回だけ送り、応答本文は保存も表示もしない（[docs/adr/codex-integration.md](docs/adr/codex-integration.md)）
- OpenCode Go はアカウント（API キー）を最大 10 件登録でき、1 アカウント = 1 カードで並べる
- 契約エラー（`subscription_required`）のアカウントは自動更新を 6 時間ごとの再確認に落とし、`⋮` の「利用枠を取得し直す」で即時に再開できる（[docs/adr/opencode-integration.md](docs/adr/opencode-integration.md)）
- 右上の `⋮` メニューの「ステータス」から、Codex・Claude・OpenCode の公式ステータスページを開ける（Gemini は取り込まない）
- PWA 用の manifest と 192 / 512px のアイコン、iOS ホーム画面用の 180px アイコンを配信する
- `GET /api/health` は DB と認証状態だけを返し、利用枠や利用者情報を含まない

`docs/design.md` は親 checkout の設計ドラフトの写しで、このプロジェクトでは書き換えない。実装との差分や決定は [docs/adr/](docs/adr) に置く。

## 起動

Bun 1.4 系を使う。`bun:sqlite` と HTML import に依存するため、Node.js では起動しない。

```bash
cd projects/usage-portal
bun install
bun run dev     # bun --hot src/server.ts
bun run start   # bun src/server.ts
```

既定では `0.0.0.0:3000` で待ち受ける。`HOST=127.0.0.1 PORT=3000 bun run dev` のように変えられる。

`/` は Preact の骨格を返す。`GET /api/health` は次の JSON を返す。

```json
{ "ok": true, "service": "usage-portal", "db": "ok", "auth": "ok" }
```

`db` は SQLite の open と migration が通っているか、`auth` は認証状態（`ok` / `setup_required` / `misconfigured`）。
`setup_required`（PIN 未設定）は故障ではないので 200 を返し、PIN ハッシュが壊れているなど `misconfigured` のときだけ 503 になる。
利用枠は返さない。応答には `Cache-Control: no-store` を付ける。

## ホーム画面への追加

iOS の Safari では共有メニューの「ホーム画面に追加」、Android / PC ではブラウザのインストール機能から追加する。
アプリ名は「Usage Portal」で、専用アイコンを使う。起動先は `/` で、PIN 認証は通常のブラウザと同じ。

Chromium の PWA インストールには HTTPS（開発時は localhost）が必要。LAN 内の HTTP ではインストール候補に出ない場合がある。
HTTPS を使う場合も公開範囲は LAN / VPN 内に留める。この変更では TLS 終端や Service Worker は追加せず、オフライン利用や API のキャッシュも行わない。
設定の判断は [docs/adr/stack-and-client.md](docs/adr/stack-and-client.md) を参照する。

## 画面の読み方

カード下端の細いバーは、次の取得までの進み具合を表す。満タンで止まったまま値が変わらなければ、
予定を過ぎても取得が来ていない。バーの上の文字は取得間隔と、最後に取得してからの経過時間で、
正確な時刻はカーソルを合わせると出る。取得に失敗しているあいだはバーを出さず、前回値と状態ラベルで示す。
バーは装飾で、判断は状態ラベルと文字で行う。
動きを減らす設定ではバーを出さず、文字だけで示す。間隔は provider ごとの設定（[docs/adr/usage-sampling-and-storage.md](docs/adr/usage-sampling-and-storage.md)）で、
`⋮` の「取得間隔」から変えられる。設定はサーバー全体に効く。

ゲージの下の行は、先頭のバッジがリセットまでの残り時間（「あと 12 日」）、続く淡色の文字がリセット日時を表す。
ローリングは 5 時間以内に終わって日付が残り時間から分かるため日付を省き、日をまたぐときだけ「リセット 翌 02:00」と出す。
Codex の 5 時間枠はプランによって返らない。カードの行を揃えるため、使用率を持たない非活性の枠を置き、値は「—」にする。
利用枠の下には「リセット枠」のセクションを置き、見出しの右に回数（「2 回」）、行に残り時間と期限（「あと 15 日」「12/13 07:36」）を出す。
期限は公式のリセット詳細から読み、取得できなかったときは回数だけを出す（期限を推測しない）。
期限なしと確認できた枠は「期限なし」、詳細の一覧に無い枠は「期限不明」として区別する。
クレジットは数値（「クレジット 13」）で出し、0 のときは「クレジットなし」、丸めると 0 になる正の値と数値を読めないときは有無だけを出す。
推移の点線はリセットを表し、線にカーソルを合わせると日時が出る（タッチ端末では出さない）。
Claude と Gemini のカードは周期取得を持たないため、取得の進み具合のバーを出さず、画面を開いたときと `⋮` の「更新」でだけ取り直す。
`⋮` の「リセット枠を取得」は通常の更新とは別で、押したときだけ回数と枠ごとの期限（「あと 13 日」「01/15 09:00」）を読む。
一度も押していなければ何も出さず、0 件と取得失敗は別の文言にする。
未接続のあいだはカードを出さず、全体メニューの「Claude」に同じ手順と「接続を確認」を置く（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）。
Gemini も同じく、未接続のあいだはカードを出さず、全体メニューの「Gemini」に手順と「接続を確認」を置く（[docs/adr/gemini-integration.md](docs/adr/gemini-integration.md)）。
Gemini の `usedPercent` は `remaining_fraction` から求め、`reset_time` を読めない・1970-01-01 のときも窓は残して「リセット時刻は不明」と出す。
カードは Codex → Claude → Gemini → 登録順のアカウントで並び、見出しの左に provider のマークを置く（[docs/adr/provider-marks.md](docs/adr/provider-marks.md)）。
すべての窓を使い切ったアカウントのカードは、一覧の末尾に回る。使い切っていない OpenCode Go のカードは、
月次の残りが多い順に並ぶ。Codex・Claude・Gemini と、月次を読めないカードは元の位置に残る。
ゲージと並び順の細部は、コードとテストを正とする。

### 公式ステータス

右上の `⋮` メニューの「ステータス」から、Codex・Claude・OpenCode の公式ステータスページを、provider のロゴ付きの項目から新しいタブで開ける。
各社の状態やモデル別の内訳はアプリに取り込まず、公式ページに任せる
（[docs/adr/service-status-links.md](docs/adr/service-status-links.md)）。

## 初回セットアップ

認証の設定は環境変数ではなく `DATA_DIR` 配下のファイルで持つ。初回起動時に次の 2 つができる。

- `session-key` — セッション cookie の署名鍵（32 bytes、0600）。無ければ起動時に自動生成する
- `pin-hash` — PIN の Argon2id ハッシュ（0600）。**初回アクセスの画面で PIN を登録したときに作られる**

デプロイ直後の `auth` は `setup_required` で、`/` を開くと PIN 登録画面になる。6 桁の PIN を登録すると、そのままログイン状態になる。
以後は同じ PIN でログインする。

PIN を忘れたときはホスト側で `pin-hash` を消す。次のアクセスで登録画面に戻り、既存の cookie はすべて無効になる。
`session-key`・`usage.sqlite`・Codex の資格情報は残るので、履歴と再サインインはやり直さない。

```bash
rm data/pin-hash
```

PIN の変更は「消して登録し直す」で行う。変更すると署名鍵の導出に使う PIN ハッシュが変わるため、全端末がログアウトする。

## API

| Method   | Path                               | 認証 | 内容                                                                                                                                                                                                                                                          |
| -------- | ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                      | 不要 | `{ ok, service, db, auth }`。常に 200 か 503（利用枠は返さない）                                                                                                                                                                                              |
| `GET`    | `/api/auth/session`                | 不要 | `{ state: "setup_required" \| "unauthenticated" \| "authenticated", expiresAt? }`。常に 200                                                                                                                                                                   |
| `POST`   | `/api/auth/setup`                  | 不要 | `{ "pin": "123456" }`。PIN 未設定のときだけ受け付け、成功で cookie を発行（201）                                                                                                                                                                              |
| `POST`   | `/api/auth/login`                  | 不要 | `{ "pin": "123456" }`。成功で cookie を発行（200）。失敗は 401、5 回失敗で 15 分ロック（429 + `Retry-After`）                                                                                                                                                 |
| `POST`   | `/api/auth/logout`                 | 不要 | cookie を消す（204）                                                                                                                                                                                                                                          |
| `GET`    | `/api/usage`                       | 必要 | `{ generatedAt, sources[] }`。各 source は `fetchIntervalMs`、`nextFetchAt`、Codex だけ `resetCredits`、Claude だけ `claudeResetCredits` を持つ。未認証は 401、認証設定が壊れていれば 503                                                                                                                                    |
| `GET`    | `/api/settings/fetch-intervals`    | 必要 | `{ intervals: { codex, "opencode-go" } }`（ミリ秒）。未設定の provider は既定値                                                                                                                                                                               |
| `PUT`    | `/api/settings/fetch-intervals`    | 必要 | `{ "provider": "codex", "minutes": 10 }`。5 / 10 / 30 / 60 / 120 以外は 400。サーバー全体に効く                                                                                                                                                              |
| `GET`    | `/api/codex/auth`                  | 必要 | `{ signedIn, login }`。`login` は進行中・終端のサインイン状態                                                                                                                                                                                                 |
| `POST`   | `/api/codex/login`                 | 必要 | サインイン開始（202）。進行中の二重開始は 409                                                                                                                                                                                                                 |
| `POST`   | `/api/codex/login/respond`         | 必要 | `{ "value": "..." }`。`select` の選択肢 ID か、ブラウザの最後の URL（204）                                                                                                                                                                                    |
| `DELETE` | `/api/codex/login`                 | 必要 | 進行中のサインインを中断（204、冪等）                                                                                                                                                                                                                         |
| `POST`   | `/api/codex/logout`                | 必要 | 保存済み OAuth を削除し、Codex の snapshot と error を消す（204）。推移の sample は同じアカウントの再サインイン用に残す                                                                                                                                       |
| `GET`    | `/api/probe/models`                | 必要 | `{ codex: [...], opencodeGo: [...] }`。`{ id, name, thinkingLevels, cost }`。ネットワークは叩かない                                                                                                                                                           |
| `GET`    | `/api/codex/probe`                 | 必要 | `{ codex: { model, thinking } \| null }`。未設定は `null`                                                                                                                                                                                                     |
| `PUT`    | `/api/codex/probe`                 | 必要 | `{ model, thinking }` → 200 `{ codex }`。catalog に無ければ `invalid_model` / `invalid_thinking`（400）                                                                                                                                                       |
| `DELETE` | `/api/codex/probe`                 | 必要 | 設定を解除（200 `{ codex: null }`）                                                                                                                                                                                                                           |
| `POST`   | `/api/codex/check`                 | 必要 | 最小プロンプトを 1 回送る → 200 `{ latencyMs }`。未設定は 409 `not_configured`、同時実行は 409 `in_progress`                                                                                                                                                  |
| `GET`    | `/api/opencode/accounts`           | 必要 | `{ accounts: [{ id, name, icon, savedAt, probeModel, probeThinking }] }`。キーは返さない                                                                                                                                                                      |
| `POST`   | `/api/opencode/accounts`           | 必要 | `{ name, icon, apiKey, probeModel?, probeThinking? }` → 201 `{ account }`。検証して保存。失敗は `invalid_name` / `invalid_icon` / `invalid_key` / `subscription_required` / `invalid_probe` / `invalid_model` / `invalid_thinking`（400）、`limit_reached`（409）、`unavailable`（503） |
| `PUT`    | `/api/opencode/accounts/:id`       | 必要 | `{ name?, icon?, apiKey?, probeModel?, probeThinking? }` → 200 `{ account }`。未知の id は 404                                                                                                                                                                |
| `POST`   | `/api/opencode/accounts/:id/check` | 必要 | そのキーで最小プロンプトを 1 回送る → 200 `{ latencyMs }`。未知の id は 404、未設定は 409 `not_configured`                                                                                                                                                    |
| `POST`   | `/api/opencode/accounts/:id/refresh` | 必要 | そのアカウントの利用枠だけを取り直す（200 `{ ok }`）。停止中でも再開できる。未知の id は 404                                                                                                                                                                  |
| `POST`   | `/api/claude/refresh`              | 必要 | `{ "mode": "auto" \| "manual" }`（省略は `auto`）→ 200 `{ state: "refreshed" \| { state: "skipped", reason } \| { state: "failed", error } }`。自動は前回取得から 15 分以内なら CLI を起動せず、手動は前回の試行から 60 秒空ける。ログアウト中は `skipped: logout` |
| `POST`   | `/api/claude/reset-credits`        | 必要 | 押されたときだけリセット枠を読む。`{ state: "refreshed" \| { state: "skipped", reason: "logout" } \| { state: "failed", error } }`。通常の更新とは別の入口 |
| `POST`   | `/api/claude/logout`               | 必要 | 公式 CLI でログアウトし、Claude の snapshot・error・リセット枠を消す（204）。推移の sample は残す。CLI / DB の失敗は 503 `logout_failed` |
| `GET`    | `/api/claude/start`                | 必要 | 開始予約の設定・オン / オフ・連続失敗の数・停止の理由・次の開始・直近 20 件の履歴 |
| `PUT`    | `/api/claude/start`                | 必要 | 予約の設定を保存（オン / オフは変えない）。不正な入力は 400 `invalid_request` |
| `PUT`    | `/api/claude/start/enabled`        | 必要 | `{ "enabled": boolean }`。オンに戻すと連続失敗の数と停止の理由を消す。設定が無ければ 409 `not_configured` |
| `POST`   | `/api/claude/start/run`            | 必要 | 今すぐ開始。200 `{ outcome: "ok" \| "skipped" \| "failed", code?, resetsAt? }`。実行中は 409 `in_progress` |
| `POST`   | `/api/gemini/refresh`              | 必要 | Claude と同じ形。`{ "mode": "auto" \| "manual" }`（省略は `auto`）→ 200 `{ state: "refreshed" \| { state: "skipped", reason } \| { state: "failed", error } }`。自動は前回の試行から 15 分以内なら CLI を起動せず、手動は 60 秒空ける。ログアウト中は `skipped: logout` |
| `POST`   | `/api/gemini/logout`               | 必要 | token を読まずに削除し、進行中の取得を待ってから `agy models` で未接続を確かめ、Gemini の snapshot と error を消す（204）。推移の sample は残す。削除後も接続が残れば 409 `logout_incomplete`（カードは残る）、削除・確認・DB の失敗は 503 `logout_failed`。応答は最大 45 秒かかる |
| `DELETE` | `/api/opencode/accounts/:id`       | 必要 | アカウントと snapshot / error / sample を削除（204）。未知の id は 404                                                                                                                                                                                        |

状態を変える要求（`POST` / `PUT` / `DELETE`）は `Origin` が要求 URL と完全一致するときだけ受け付ける（`Origin` の無い要求も 403）。
応答はすべて `Cache-Control: no-store`。ログインの試行制限は接続元ごとに数え、同時に届いた要求も直列化して 5 回を超えて照合しない。

送信系の 2 つ（`/api/codex/check`・`/api/opencode/accounts/:id/check`）は同じ契約で失敗を返す。
401 / 403 は Codex が `reauth_required`、OpenCode Go が `invalid_key`、429 は `limit_reached`、400 / 404 は
`model_unavailable`、それ以外と stream の異常終了は `unavailable`。応答本文と上流のエラー文は返さない。
Codex の 5 時間窓が API に返らないアカウントがあるため、「開始済み」の判定は持たない（再送しても 5 時間は延びない）。

`sources[]` は source ごとに独立して失敗する。`id` は `codex`・`claude`・`gemini`・アカウントの uuid、`provider` は `codex` /
`opencode-go` / `claude` / `gemini`、`account` は OpenCode Go の `{ id, name, icon }`（Codex・Claude・Gemini は `null`）で、応答の並びは
Codex → Claude → Gemini → 登録順。
画面はこの並びを使い切ったカードの移動と月次の残り順で並べ替える。
`state` は `loading` / `ok` / `stale` / `error`、`error.code` は `not_connected` / `reauth_required` / `subscription_required` / `upstream` / `schema` /
`config` の固定値で、上流の本文は含まない。未サインインの Codex・Claude・Gemini は `not_connected` になり、Codex は画面では「未接続」と出す。
Claude と Gemini は `not_connected` のあいだカードを出さず、全体メニューから手順を開く。Claude と Gemini の `nextFetchAt` は常に `null`（周期取得が無い）で、`fetchIntervalMs` は 15 分固定。

## Codex のサインイン

Codex の OAuth は自前実装せず、Pi SDK（`@earendil-works/pi-coding-agent`）の `ModelRuntime` を資格情報の
読み取り・更新・サインインだけに使う。資格情報は `CREDENTIAL_DIR`（既定 `/app/credentials`）に置き、ホストの
`~/.pi/agent` とは共有しない（同じ refresh token を 2 プロセスで更新すると片方が壊れるため）。

1. Codex カードの「Sign in with ChatGPT」を押す
2. サインイン方法を選ぶ（既定はデバイスコード。ブラウザを選んだ場合は最後の URL を貼り付けて完了する）
3. 表示された URL とコードで承認する
4. 成功すると `auth.json` に保存され、sampler が 1 回走って Codex カードが更新される

サインアウトはカード右上の `⋮` から行う（サインイン済みのときだけ出る）。サインアウト中は推移も出さないが、
同じ ChatGPT アカウントで戻ると、残しておいた sample から推移を引き継ぐ（[docs/adr/usage-sampling-and-storage.md](docs/adr/usage-sampling-and-storage.md)）。
未接続・再サインインのときの「Sign in with ChatGPT」は、カードの中に残る。

コールバックポート（1455）は publish しない。コンテナ内の `127.0.0.1` に閉じるため、どのブラウザからでも
デバイスコードか貼り付けで完了できるようにしてある。進行中の状態は BFF のメモリだけに置き、開始から 10 分で自動中断する。

## Claude のサインイン

Claude は Web UI でサインインを中継しない。公式 `claude` CLI を image に版固定で入れ、その CLI 自身に
サインインさせる。このアプリはトークンも `.credentials.json` も直接読まない（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）。

1. 稼働中のコンテナへ入って、サブスクリプションのアカウントでサインインする

   ```bash
   docker exec -it <コンテナ名> claude auth login
   ```

2. 画面を開くか、Claude カードの `⋮` →「更新」を押す
3. 未接続のあいだはカードが出ない。全体メニューの「Claude」に同じ手順を出し、サインイン後に「接続を確認」を押すとカードが戻る
4. カードを隠すときは `⋮` →「ログアウトして非表示」→「ログアウトする」。公式 CLI が資格情報を破棄し、カードが消える

ログアウトで資格情報は CLI が削除する。利用枠の履歴（sample）は残り、再ログイン後の推移に引き継がれる。
`api_key_helper` など設定ファイル由来の API キーが残っている場合は、ログアウトしてもカードが戻ることがある。
そのときは `subscription_required` のカードと Claude のモーダルに出る手順に従い、`CLAUDE_CONFIG_DIR` の設定から
API キーの指定を外す（[docs/adr/claude-integration.md](docs/adr/claude-integration.md)）。

資格情報は `CREDENTIAL_DIR`（既定 `/app/credentials`）の `claude/` に置き、ホストの `~/.claude` とは共有しない。
image の `CLAUDE_CONFIG_DIR` は `CREDENTIAL_DIR/claude` にしてあるので、`docker exec` で実行する CLI も同じ場所を読む。
`bun run dev` で動かすときは `CLAUDE_CONFIG_DIR=./credentials/claude claude auth login` を使う。

取得は画面を開いたとき（初回表示とタブが見える状態へ戻ったとき）と手動更新だけ。前回の取得から 15 分以内なら
CLI を起動せず保存済みの値を使い、手動更新は前回の試行から 60 秒空ける。失敗しても自動では再試行しない。
カードが出ていないあいだは、全体メニューの「Claude」の「接続を確認」が手動更新と同じ経路になる。
CLI の出力本文は DB・ログ・応答に残さず、正規化した利用枠と sample だけを保存する。

## Gemini のサインイン

Gemini も Web UI でサインインを中継しない。公式 `agy`（Antigravity CLI）を image に版固定で入れ、その CLI 自身に
サインインさせる。このアプリはトークンを読まず、保存も送信もしない（ログアウトの削除だけが例外。
[docs/adr/gemini-integration.md](docs/adr/gemini-integration.md)）。

`agy` は設定と token を `$HOME/.gemini/antigravity-cli` に置き、設定ディレクトリの環境変数を持たない。
アプリは `HOME` を `CREDENTIAL_DIR/antigravity` に差し替えて起動するので、サインインも同じ `HOME` で行う。

1. 稼働中のコンテナへ入って、Google AI のアカウントでサインインする

   ```bash
   docker exec -it -e HOME=/app/credentials/antigravity <コンテナ名> agy
   ```

   `CREDENTIAL_DIR` を既定から変えているときは、`HOME` も `<CREDENTIAL_DIR>/antigravity` に合わせる。
2. 画面を開くか、全体メニューの「Gemini」で「接続を確認」を押す
3. 未接続のあいだはカードが出ない。サインイン後にカードが戻る
4. カードを隠すときは `⋮` →「ログアウトして非表示」→「ログアウトする」。進行中の取得があれば終わるのを待つため、最大 45 秒かかる

`bun run dev` で動かすときは `HOME="$PWD/credentials/antigravity" agy` を使う。OS の keyring を使うホストでは、
`HOME` で分離できず、ログアウトしても接続が残る（409）ことがある。

取得は Claude と同じく画面を開いたときと手動更新だけで、前回の試行から 15 分以内なら CLI を起動せず、手動更新は
60 秒空ける。CLI の出力本文・stderr・OAuth の URL・メールは DB・ログ・応答に残さない。
image の `AGY_CLI_DISABLE_AUTO_UPDATE=1` は CLI の自動更新を止めるための設定で、アプリが読む環境変数ではない
（`CLAUDE_CONFIG_DIR` と同じく、子プロセスへ明示的に渡す）。

## 最小プロンプトの送信

Codex の「接続確認」と OpenCode Go の「接続確認」は、どちらも固定の 1 文（`Reply with the single word OK.`）を
1 回だけ送る。応答本文は使わず、成功・失敗・latency・固定のエラーコードだけを扱う（[docs/adr/codex-integration.md](docs/adr/codex-integration.md)）。

1. Codex カードの `⋮` →「Codex の開始設定」でモデルと思考レベルを選ぶ（どちらも選ぶまで保存できない）
2. `⋮` に「接続確認」が出る。押すと送信し、そのあと利用枠を取り直す
3. OpenCode Go はアカウントの追加・編集フォームでモデルと思考レベルを選ぶと、`⋮` に「接続確認」が出る
4. 設定を解除すると入口も消える

Codex の「接続確認」は、5 時間の利用枠を開始する送信でもある。

送信しても利用枠の表示にすぐ反映されないことがある。リセット時刻は取得できたときにだけ出す。
既定のモデルは置かない。Codex の送信後は全 source を取り直すため、アカウントが多いと数秒かかる。

## OpenCode Go のアカウント

OpenCode Go の API キーは `.env` ではなく画面から登録する。アカウント（名前 / アイコン / API キー）は
`CREDENTIAL_DIR`（既定 `/app/credentials`）の `opencode-accounts.json` に 0600 で保存し、応答・ログ・DB には
キーを出さない。

1. 右上の `⋮` メニューで「アカウントを追加」を押す（未登録なら一覧の案内カードからも開ける）
2. 名前・アイコン・API キーを入れて「追加する」。BFF が上流の usage endpoint に 1 回問い合わせ、
   受け付けられたときだけ保存する
3. 受け付けられなければ入力欄の下に理由が出る。アカウントは保存されない。403（契約なし）は
   `subscription_required` として、キーの誤りと区別して表示する
4. 名前・アイコンを変えるときはカード右上の `⋮` →「編集」、キーを変えるときも同じ場所で新しいキーを入れる（空欄なら変更しない）
5. 消すときはカード右上の `⋮` →「削除」→「削除する」

上限は 10 アカウント。未登録のときは一覧に案内カードを出し、Codex のカードだけを並べる。
登録・変更・削除は sampler の排他区間で行い、成功するとその場で 1 回取得してカードを更新する。

旧バージョンの `opencode-key.json` は読み込まない。デプロイ後に画面から登録し直し、旧ファイルは手動で削除する
（キーが平文で残るため）。

```bash
rm credentials/opencode-key.json
```

## 環境変数

`bun run dev` / `bun run start` はカレントディレクトリの `.env` を自動で読む（Bun の挙動）。雛形は [.env.example](.env.example)。

| 変数               | 既定               | 内容                                                                                                                                       |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST`             | `0.0.0.0`          | 待ち受けアドレス                                                                                                                           |
| `PORT`             | `3000`             | 待ち受けポート                                                                                                                             |
| `DATA_DIR`         | `/app/data`        | SQLite と認証状態（`pin-hash` / `session-key`）、送信の設定（`settings.json`）の置き場。起動時に 0700 で作り、配下のファイルを 0600 にする |
| `CREDENTIAL_DIR`   | `/app/credentials` | Codex の `auth.json` / `device-id` と OpenCode Go の `opencode-accounts.json`、Claude の `claude/`、Gemini（agy）の `HOME` の `antigravity/` の置き場。起動時に 0700、配下のファイルを 0600 にする        |
| `POLL_INTERVAL_MS` | `600000`           | 画面から設定していない provider の取得間隔。1 分未満・非整数は起動しない（画面から選べるのは 5 分以上）                                      |
| `COMMIT_HASH`      | なし               | build 時に埋め込む。`User-Agent: usage-portal/<version>` の version になる                                                                 |
| `TRUST_PROXY`      | `0`                | `1` のときだけ `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Forwarded-For` を信頼する。TLS 終端を前段に置く構成で使う                     |
| `COOKIE_SECURE`    | `auto`             | `1` なら常に cookie へ `Secure` を付ける。`auto` は要求が HTTPS のときだけ付ける（`TRUST_PROXY=1` なら転送ヘッダーも見る）                 |

`PI_CODING_AGENT_DIR` は Dockerfile で `CREDENTIAL_DIR` と同じ値にしている。`CLAUDE_CONFIG_DIR` も Dockerfile で
`CREDENTIAL_DIR/claude` にしている（Claude CLI が資格情報を書く場所で、アプリは子プロセスへ明示的に渡す）。
Gemini の `agy` の `HOME` は `CREDENTIAL_DIR/antigravity` に固定で、アプリが子プロセスへ明示的に渡す。
image の `AGY_CLI_DISABLE_AUTO_UPDATE=1` は `agy` の自動更新を止める。
PIN とセッション鍵は環境変数では渡さない。

## Docker

`test` ステージは `bun install --frozen-lockfile` の後に `bun run check` を実行する。`final` ステージは非 root（uid/gid 1000）で `bun src/server.ts` を起動する。
どちらも `oven/bun` のパッチ版（1.4.5 / 1.4.5-slim）を digest で固定している。

`final` には公式 Claude Code CLI を、`downloads.claude.ai` の版固定バイナリを公式 manifest の checksum で検証して入れる
（ビルド時に約 370 MB を取得する）。バイナリは root 所有の 0755 で置き、実行ユーザーからは書き換えられない。
実行ユーザーはこのファイルを置き換えられないため、自動更新が試されても版は Dockerfile の `CLAUDE_CODE_VERSION` のまま固定される。

同じく `final` には Antigravity CLI（`agy`）を、公式 installer が使う manifest の `url` / `sha512` を写して版固定で入れる
（`AGY_CLI_VERSION`。tar.gz で約 99 MiB、展開後 約 281 MB）。アーキテクチャ（`uname -m`）ごとに URL と SHA-512 を持ち、
ビルド時に SHA-512 と `agy --version` を検証する。root 所有の 0755 で `/usr/local/bin/agy` に置き、`AGY_CLI_DISABLE_AUTO_UPDATE=1` を
image の `ENV` にも置く。manifest は最新版だけを指すため、版を上げるときは両 arch の URL・SHA-512・`AGY_CLI_VERSION` を同時に直し、
`test/providers-gemini.test.ts` の fixture を `agy -p "/usage" --output-format json` の出力と突き合わせる。

```bash
docker build --target test -t usage-portal-test ./projects/usage-portal
docker build --target final -t usage-portal-final ./projects/usage-portal

docker run --rm -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/credentials:/app/credentials" \
  usage-portal-final
```

`/app/data` と `/app/credentials` はイメージ内で uid 1000 が書けるようにしてある。ホスト側のディレクトリを
マウントするときは所有者を合わせる（`install -d -m 700 -o 1000 -g 1000` 相当）。

- `data/` には `usage.sqlite`、`session-key`、初回セットアップ後の `pin-hash` が入る。消すと PIN と履歴が初期化される
- `credentials/` には Codex の `auth.json`（refresh token と account id）、`device-id`、OpenCode Go の `opencode-accounts.json`（API キーとアカウント名）、Claude の `claude/`（CLI 自身の設定と資格情報）、Gemini の `antigravity/`（`agy` の `HOME`。設定・token・会話の cache）が入る。**バックアップやログに出さない**。Claude の資格情報はカードの「ログアウトして非表示」で CLI が削除し、Gemini の token はアプリが読まずに削除する

### Claude Code CLI の版更新

Dependabot はこの取得経路（`FROM` 行を持たない直ダウンロード）を追えないため、
[.github/workflows/claude-cli-version-check.yml](../../.github/workflows/claude-cli-version-check.yml) が
週次（月曜 06:00 JST）で `https://downloads.claude.ai/claude-code-releases/stable` と固定版を比べ、新しい版があれば
`CLAUDE_CODE_VERSION` を上げる PR を作る。PR の作成までを自動化し、マージと次の確認は人間が行う。

1. 上げた版の manifest に linux-x64 / linux-arm64 の checksum があることと、`claude-cli` ステージのビルド
   （checksum 検証と `claude --version`）は workflow が確認する。失敗したら PR は作られない
2. PR のブランチでも、新しい版の CLI を実際に動かして `/usage` と認証状態の出力を確かめる

   ```bash
   docker exec <コンテナ> claude -p /usage --output-format json --no-session-persistence | jq -r .result
   docker exec <コンテナ> claude auth status --json
   ```

   出力が `test/providers-claude.test.ts` の fixture と違っていれば、fixture と `src/server/providers/claude.ts` を直す。
   workflow は `GITHUB_TOKEN` で PR を作るため CI は自動で走らない。この確認で 1 コミット push すれば CI が走る。
3. `stable` は新しい版より遅れて追いつくことがある。固定版のほうが進んでいるときは下げる提案をしない
4. PR の作成には repository の設定（Settings → Actions → General → Workflow permissions の
   「Allow GitHub Actions to create and approve pull requests」）が必要。無効のままだと、ブランチを push した
   あとの `gh pr create` だけが失敗する
5. 同じブランチ名が既にある場合の扱いは次のとおり。PR があれば何もしない。PR が無く workflow が作った
   コミットだけが残っている（PR 作成に失敗した残骸）なら、確認した SHA を lease にして作り直す。
   人が push したブランチなら上書きせず見送る（手で版を上げている途中はそちらを優先する）

## ディレクトリ構成

```text
index.html                 HTML の入口（Bun が src/client/main.tsx をバンドルする）
src/server.ts                 Bun.serve。HTML と /api/* の振り分け、DB・認証・sampler の初期化
src/server/app.ts             Hono app と AppType、認証 API・利用枠 API・同一 origin 検査
src/server/auth.ts            PIN の登録・照合とセッションの発行・検証
src/server/auth-store.ts      pin-hash / session-key の読み書きと権限
src/server/pin.ts             PIN の形式と Argon2id
src/server/session.ts         署名付き cookie の形式と検証
src/server/rate-limit.ts      ログイン試行の制限
src/server/config.ts          HOST / PORT / DATA_DIR / CREDENTIAL_DIR / POLL_INTERVAL_MS
src/server/db.ts              SQLite の open / migration / snapshot・error・sample の読み書き
src/server/sampler.ts         source ごとのスケジュール取得（single-flight）と 30 日保持
src/server/fetch-intervals.ts provider ごとの取得間隔（SQLite）
src/server/usage.ts           /api/usage の応答（state と trends）の組み立て
src/server/state.ts           snapshot と error から state を決める
src/server/trend.ts           窓の期間と、推移の downsample
src/server/health.ts          /api/health の応答
src/server/version.ts         version と User-Agent の組み立て
src/server/providers/         Codex / OpenCode Go / Claude の adapter と正規化モデル
src/server/claude/            Claude CLI の子プロセス起動と、取得の契機（single-flight、15 分 / 60 秒）
src/server/gemini/            agy の子プロセス起動と、取得の契機・ログアウト（single-flight、15 分 / 60 秒、取得と直列）
src/server/codex/             Pi SDK の資格情報、SiWC の状態機械、/api/codex/*
src/server/opencode/          OpenCode Go のアカウントの保存と /api/opencode/*
src/server/probe/             送信の設定（settings.json）、モデル catalog、最小プロンプトの送信
src/shared/                    server と client で共有する入力規則（アカウント名・アイコン・キー）と、周期取得の無い provider の判定
src/client/main.tsx           Preact の描画入口
src/client/App.tsx            セッション・利用枠・アカウントの取得と画面の切り替え
src/client/api.ts             API の呼び出しと応答の解釈
src/client/lib/format.ts      残り時間・%・日時の整形
src/client/lib/chart.ts       推移の縦軸レンジと横軸の目盛り
src/client/lib/windows.ts     推移の初期表示に選ぶ窓
src/client/lib/view-mode.ts  簡易 / 標準の保存値（localStorage）
src/client/lib/status.ts      状態ラベルとしきい値
src/client/lib/claude.ts      Claude のカードを出すかの判定と、カード・全体メニューで共通の文言
src/client/lib/gemini.ts      Gemini のカードを出すかの判定と、カード・全体メニューで共通の文言
src/client/lib/account-color.ts  アカウントのアイコン背景色（id のハッシュから選ぶ）
src/client/components/        ログイン、source カード、meter、trend、アカウントの編集、送信の設定、表示の切り替え
src/client/styles.css         CSS トークンとレイアウト
test/                         bun:test
scripts/docs-check.mjs        docs の相対リンクとパスの検査
docs/design.md                設計（親 checkout からの写し）
docs/adr/                     決定の記録
```

## 検証

```bash
cd projects/usage-portal
bun install --frozen-lockfile
bun run check
```

`check` は lint / fmt:check / typecheck / test / docs:check を順に実行する。
ライセンスはリポジトリ root から `./scripts/check-licenses --target projects/usage-portal` で確認する。

## セキュリティの前提

- 自宅 LAN または VPN の内側からだけ使う。インターネットへ公開しない。TLS 終端を前段（Caddy など）に置く場合は `TRUST_PROXY=1` を設定する
- 画面は利用枠を変更しない。資格情報（Codex のサインイン、OpenCode Go のアカウント）の登録・変更・削除と、
  明示的に押したときの最小プロンプト 1 回の送信だけを行う（送るのはサーバ側の固定 1 文で、利用者の入力は混ぜない）
- Claude は公式 CLI を未改変で使い、トークンと `.credentials.json` を直接読まない。サインインもログアウトも Web UI で中継せず、CLI 自身に行わせる
- Gemini も公式 `agy` を未改変で使い、token を読まない・保存しない・送信しない。サインインは CLI 自身に行わせ、ログアウトだけは `agy` に非対話の手段が無いため、token ファイルを読まずに削除して `agy models` で確かめる
- 認証情報と DB の中身は API から返さない。`/api/health` は状態だけを返し、利用枠や利用者情報を含めない
- SQLite と認証状態は `DATA_DIR`（0700）に置き、ファイルを 0600 にし、プロセスの先頭で `umask 077` を設定する
- Codex の token・account id・email、OpenCode の API key は応答・ログ・DB に残さない。上流の応答本文も保存しない
- Claude の CLI 出力本文とメール・組織の情報は、DB・ログ・応答に残さない（読むのは `loggedIn` / `authMethod` /
  `subscriptionType` / `loginExpiresAt` だけ）。子プロセスへ渡す環境変数は `PATH` / `HOME` / `CLAUDE_CONFIG_DIR` / `TZ` に絞り、
  cwd は空の一時ディレクトリにする
- Gemini の CLI 出力本文・stderr・OAuth の URL・メール・bucket の `name` / `description` は、DB・ログ・応答に残さない
  （読むのは `gemini-*` の bucket の `id` / `window` / `remaining_fraction` / `reset_time` だけ）。子プロセスへ渡す環境変数は
  `PATH` / `HOME` / `TZ` / `AGY_CLI_DISABLE_AUTO_UPDATE` に絞り、cwd は空の一時ディレクトリにする
- 送信の成否は status・`stopReason`・latency・固定のエラーコードだけを扱い、プロンプトも応答も保存しない
- `/app/credentials` は 0700、`auth.json` / `device-id` / `opencode-accounts.json` は 0600、`claude/` と `antigravity/` は 0700。ホストの Pi 資格情報や `~/.claude`・`~/.gemini` とは共有しない
- `opencode-accounts.json` はアカウント数だけキーを平文で持つ。旧 `opencode-key.json` を残すとキーが二重に残るため、登録後に削除する
- PIN、PIN ハッシュ、セッション鍵、cookie、API key、token をログに出さない
- セッション cookie は `HttpOnly; SameSite=Lax`。`Secure` は `COOKIE_SECURE` / `TRUST_PROXY` に従う（既定は HTTPS の要求のときだけ付与）
- 6 桁 PIN は総当たり耐性が低い。Argon2id とログイン試行の制限で補い、インターネット公開には使わない

## 参考

- [AGENTS.md](AGENTS.md) — このプロジェクトで作業するエージェント向けの規約
- [docs/design.md](docs/design.md) — 全体設計
- [docs/adr/stack-and-client.md](docs/adr/stack-and-client.md) — スタックと client の取得方式（ポーリング、PWA）
- [docs/adr/auth-and-exposure.md](docs/adr/auth-and-exposure.md) — 入口の認証と公開範囲（6 桁 PIN、自宅 LAN / VPN 前提）
- [docs/adr/usage-sampling-and-storage.md](docs/adr/usage-sampling-and-storage.md) — 利用枠の取得・保存と窓の扱い
- [docs/adr/provider-marks.md](docs/adr/provider-marks.md) — provider のマークと同梱アセット
- [docs/adr/opencode-integration.md](docs/adr/opencode-integration.md) — OpenCode Go との連携（アカウント・契約エラー・再取得）
- [docs/adr/codex-integration.md](docs/adr/codex-integration.md) — Codex との連携（資格情報・サインイン・送信）
- [docs/adr/claude-integration.md](docs/adr/claude-integration.md) — Claude との連携（公式 CLI・取得の契機・開始予約）
- [docs/adr/gemini-integration.md](docs/adr/gemini-integration.md) — Gemini との連携（公式 CLI・取得の契機・ログアウトの例外）
- [docs/adr/service-status-links.md](docs/adr/service-status-links.md) — 稼働状況は取り込まず公式ページへリンクする
