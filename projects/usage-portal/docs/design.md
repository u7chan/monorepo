# Usage Portal 設計

- Status: Proposed
- Date: 2026-10-25
- 仮称: `projects/usage-portal`

## 1. 目的

Codex（ChatGPT サブスクリプション）と OpenCode Go の利用枠を、1 ページで確認できるようにする。Docker コンテナとして動かし、`self-hosted-runner` リポジトリの Compose 定義で構成管理する。主な利用端末はスマホで、PC でも同じ画面を見る。既存の `projects/portal`（Docker コンテナ用）とは別の、読み取り専用ダッシュボードとする。

### Why

利用枠は Codex と OpenCode の別々の画面にあり、確認のたびに移動が必要になる。今どの枠がどれだけ残っていて、いつリセットされるかだけを 1 か所で見たい。自宅 LAN からスマホで見るため、誰でも開ける状態にはせず、PIN で入口を制限する。

### What

- Codex と OpenCode Go の現在の利用枠を同時に表示する
- 使用率、残り、リセットまでの時間、リセット日時を表示する
- 最後に取得できた時刻と、取得できていない状態を区別して表示する
- 直近 24 時間の使用率の推移を小さく表示する
- PIN でログインし、30 日間セッションを保持する
- セッション期限が近づいたらバナーで再ログインを促す
- Codex は u7agent と同じ「Sign in with ChatGPT」の仕組みで接続する
- 表示は `pi-console` の usage 画面に合わせる
  - Codex は API が返した窓だけを出す。週次が返らないアカウントでは週次行を出さない
  - OpenCode Go は rolling / weekly / monthly の 3 窓を表示対象とし、API が返した窓を出す（通常は 3 つ）
  - 80% 以上を注意表示にする
- 画面は読み取り専用とし、利用枠を変更する操作は持たない

### Constraints

- 認証情報は BFF とコンテナ内のファイルだけに置き、ブラウザへ返さない
- 上流 API は公開契約ではないため、失敗時は前回の値を保持して stale と表示する
- 1 アカウントずつを対象とする（Codex 1、OpenCode Go 1）
- 自宅 LAN または VPN からの閲覧を想定し、インターネットへは公開しない
- コンテナは非 root で動かし、書き込み先を data と credentials に限定する

### 非目的

- 複数アカウントの集約
- リクエスト単位の履歴、トークン数、コストの集計
- 通知、しきい値アラート、利用枠のリセット操作
- 上流の利用履歴ページの完全な再現
- パスキー、TOTP、ユーザー管理
- OpenCode Go の API key を Web UI から編集すること

## 2. 結論

- Runtime / package manager / bundler / test: Bun
- BFF: Hono（`hc` で型共有）
- Client: Preact + TSX
- Storage: `bun:sqlite`（ORM なし）
- Styling: 素の CSS + CSS 変数 + `up-` 接頭辞
- Codex の資格情報管理: `@earendil-works/pi-coding-agent` の `ModelRuntime` を認証だけに使う
- Codex のサインイン: u7agent と同じ SiWC の Web サインイン（`ModelRuntime.login`）
- 取得: BFF が 5 分ごとに上流をポーリングし、SQLite に保存する。Client は 60 秒ごとに BFF のスナップショットを取得する
- 認証: 6 桁 PIN + 署名付き HttpOnly cookie。期限 30 日、残り 3 日でバナー
- 配布: monorepo で Docker イメージを build し、`self-hosted-runner` の `deploy/usage-portal.yml` で動かす
- 公開ポート: `3001`（`portal` の 3000 と対にする）

```text
Browser (Preact)
  │ GET /api/auth/session, POST /api/auth/login
  │ GET /api/usage  60s
  │ GET /api/codex/auth  起動時 + サインイン中 2s
  ▼
Bun + Hono BFF
  │ PIN session middleware
  │ 5min sampler（single-flight）
  ├── Codex adapter ──────→ chatgpt.com/backend-api/wham/usage
  ├── OpenCode adapter ───→ opencode.ai/inference/go/v1/usage
  ├── Pi SDK ModelRuntime → /app/credentials/auth.json（Codex OAuth）
  └── SQLite
        provider_snapshot / provider_error / usage_sample
```

### SSE を使わない理由

利用枠の変化は分単位で、操作もない。1 本の GET のポーリングで十分であり、再接続、スナップショットの再適用、接続状態の管理を持ち込む理由がない。`hwc` の SSE は Herdr の状態変化を即時反映するための判断であり、この用途には当てはめない。

## 3. デプロイ構成

### 3.1 リポジトリの分担

| リポジトリ | 役割 |
| --- | --- |
| `u7chan/monorepo` | `projects/usage-portal` の実装、Dockerfile、テスト、GHCR への image push |
| `u7chan/self-hosted-runner` | `deploy/usage-portal.yml`、`deploy/targets.json`、manual deploy の target、運用手順 |

monorepo の CD が `ghcr.io/u7chan/monorepo/usage-portal` を push した後に、self-hosted-runner の manual deploy で `usage-portal` target を実行する。

### 3.2 コンテナ

- Base image: `oven/bun`（test） / `oven/bun:1-slim`（final）
- `ARG COMMIT_HASH` を受け取り、final の `ENV COMMIT_HASH` と `User-Agent: usage-portal/<version>` に使う
- final に `ca-certificates` を入れる
- 非 root（uid/gid 1000、`bun` user）で実行
- `init: true`、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`
- 公開ポート: `3001:3000`（コンテナ内は 3000）
- ネットワーク: `home_network`（`portal`、`file-server` と同じ）
- 書き込み先:
  - `/app/data` — SQLite
  - `/app/credentials` — Codex の `auth.json` と device-id
- 環境変数（`.env`）:
  - `PIN_HASH_B64`
  - `SESSION_SECRET`
  - `OPENCODE_API_KEY`
- 任意:
  - `COOKIE_SECURE`（既定 `auto`。自宅 LAN / VPN の HTTP では付かない）
  - `TRUST_PROXY`（既定 `0`）
  - `POLL_INTERVAL_MS`（既定 `300000`）

### 3.3 Compose 案

```yaml
networks:
  default:
    name: home_network

services:
  usage-portal:
    container_name: usage-portal
    image: ghcr.io/u7chan/monorepo/usage-portal:${PROJECT_IMAGE_TAG:-latest}
    init: true
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "3001:3000"
    env_file:
      - ${ENV_FILE:-/dev/null}
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "3000"
      DATA_DIR: /app/data
      CREDENTIAL_DIR: /app/credentials
      PI_CODING_AGENT_DIR: /app/credentials
      COOKIE_SECURE: ${COOKIE_SECURE:-auto}
      TRUST_PROXY: ${TRUST_PROXY:-0}
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - ${DATA_PATH:-/home/u7chan/deploy/usage-portal/data}:/app/data
      - ${CREDENTIAL_DIR:-/home/u7chan/deploy/usage-portal/credentials}:/app/credentials
    healthcheck:
      test: [CMD, bun, -e, "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

Codex のブラウザログイン用コールバック（1455）は publish しない。ホストの Pi / Codex のログインと衝突するためで、サインインはデバイスコードまたは貼り付け経路を使う。

### 3.4 `deploy/targets.json` 案

```json
{
  "targets": {
    "usage-portal": {
      "service_name": "usage-portal",
      "needs_ghcr_login": true,
      "cleanup_image_path": "monorepo/usage-portal",
      "requires_env_file": true,
      "runtime_dirs": {
        "DATA_PATH": "data",
        "CREDENTIAL_DIR": "credentials"
      },
      "post_deploy_writable_paths": ["/app/data", "/app/credentials"],
      "access_url": true
    }
  }
}
```

`manual-deploy.yml` の target choice にも `usage-portal` を追加する。`tests/test_deploy_targets.py` が choice と `targets.json` の一致を見るため、追加漏れは CI で落ちる。

### 3.5 `.env`

`/home/u7chan/deploy/usage-portal/.env` に手動配置する。`.env` は 0600、リポジトリには置かない。

```env
# bun run hash-pin の出力。base64url にして Compose の $ 展開を避ける
PIN_HASH_B64=<base64url>

# bun run generate-session-secret の出力
SESSION_SECRET=<base64url 32 bytes>

# OpenCode Go の API key
OPENCODE_API_KEY=<key>

# 省略可
# COOKIE_SECURE=1
# TRUST_PROXY=1
# POLL_INTERVAL_MS=300000
```

`PIN_HASH_B64` は `$argon2id$...` を base64url にしたもの。Compose の `env_file` は値を補間するため、`$` を含む生のハッシュをそのまま書かない。

### 3.6 Codex のサインイン

Codex は Web UI からサインインする。初回も再認証も同じ経路で、CLI は使わない。

1. Codex カードの「Sign in with ChatGPT」を押す
2. サインイン方法を選ぶ
   - デバイスコード（スマホ向け。既定）
   - ブラウザ（コールバックはコンテナ内に閉じるため、最後の URL を貼り付ける）
3. 表示された URL / コードで承認する
4. 成功すると `/app/credentials/auth.json` に保存され、次の取得から利用枠が出る

サインイン状態は BFF のメモリだけに持つ。コンテナを再起動すると進行中のサインインは消えるが、保存済みの `auth.json` は残る。

## 4. 認証（PIN）

### 4.1 方式

- 6 桁の数字 PIN を 1 つだけ持つ。ユーザー名は無い
- PIN は Argon2id のハッシュ（`Bun.password`）だけを保持する
- ログイン成功で署名付き cookie を発行する。サーバー側のセッションテーブルは持たない
- セッション有効期間は 30 日
- 期限まで 3 日以下になったら、ダッシュボードに再ログインのバナーを出す
- ログアウトは cookie を削除する。サーバー側の失効リストは持たない

### 4.2 PIN の保存

`bun run hash-pin` が PIN を非表示で 2 回入力させ、次を出力する。

```text
PIN_HASH_B64=<base64url of $argon2id$...>
```

- `Bun.password.hash(pin, { algorithm: "argon2id" })` を使う
- `PIN_HASH_B64` を decode した値が `$argon2id$` で始まることを起動時に検証する。違えば認証設定不正（503）
- PIN は 6 桁の数字だけを受け付ける
- `.env` には生の PIN を書かない
- PIN を変更すると `PIN_HASH_B64` が変わる。セッション署名の鍵に PIN ハッシュを含めるため、変更時は全端末がログアウトされる

### 4.3 セッション cookie

- 名前: `usage_portal_session`
- 値: `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`
- payload: `{ "v": 1, "iat": <epoch ms>, "exp": <epoch ms> }`
- 署名鍵: `key = base64url_decode(SESSION_SECRET)`、`message = "usage-portal-session:" + PIN_HASH_B64`、`sig = base64url(HMAC-SHA256(key, message))`
- 属性: `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
- `Secure`:
  - `COOKIE_SECURE=1` なら付与
  - `auto` なら request が HTTPS、または `TRUST_PROXY=1` かつ `X-Forwarded-Proto: https` のときだけ付与
- cookie の検証は署名を timing-safe に比較し、`exp` を確認する。失敗は未認証として扱う

サーバー側にセッションを持たないため、cookie を盗まれた場合は有効期限まで使える。ログアウトはブラウザの cookie を消すだけで、盗まれた cookie は失効しない。この用途では許容する。必要になったら SQLite のセッションテーブルへ移す。

### 4.4 セッション期限のバナー

`GET /api/auth/session` は認証済みのとき `expiresAt` を返す。Client は次の条件でバナーを出す。

```text
0 < expiresAt - now <= 3日
```

文言は「ログインの有効期限が近づいています（あと N 日）」とし、「PIN を再入力」ボタンを置く。`あと` は meter と同じ formatter を使い、24 時間未満は時間 / 分で出す。再入力に成功すると新しい 30 日の cookie が発行され、バナーは消える。期限切れで API が 401 になった場合は、ログイン画面に「セッションが切れました」と出して PIN を求める。

バナーは閉じるボタンを付けない。ページを再読み込みしても期限が近い間は出る。うるさく感じる場合は、表示条件を 1 日へ短くできる。

### 4.5 ログイン試行の制限

- 失敗の記録はメモリ上の sliding window。DB には書かない
- 失敗のキーは次のようにする
  - `TRUST_PROXY=0`: Bun の socket IP だけを使い、`X-Forwarded-For` は読まない
  - `TRUST_PROXY=1`: 信頼する前段が付けた `X-Forwarded-For` の先頭を使う
- 5 回失敗したら 15 分ロックする
- 成功したらそのキーの失敗履歴を消す
- ロック中は HTTP 429 と `Retry-After` を返す。画面は残り時間を表示し、送信を無効化する
- PIN の検証は Argon2id で意図的に遅い。失敗時も同じ経路を通す
- PIN、ハッシュ、試行回数、cookie をログに出さない

### 4.6 認証 API

| Method | Path | 認証 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/auth/session` | 不要 | `{ authenticated, expiresAt }`。cookie の検証だけを行う |
| POST | `/api/auth/login` | 不要 | `{ pin: string }`。成功で cookie を設定 |
| POST | `/api/auth/logout` | 必要 | cookie を削除して 204 |
| GET | `/api/usage` | 必要 | 利用枠のスナップショット |
| GET | `/api/health` | 不要 | コンテナ用。利用枠は返さない |

- login の body は 1 KiB まで。`pin` は文字列 6 桁だけを受け付ける
- login の失敗は `401 { error: "invalid_pin" }`、ロック中は `429 { error: "rate_limited", retryAfterSeconds }`
- `/api/usage` が未認証なら `401 { error: "unauthorized" }`
- `POST` は `Origin` が同一 origin のときだけ受け付ける。`SameSite=Lax` と併用する
- 認証 API と `/api/usage` は `Cache-Control: no-store`
- `PIN_HASH_B64` または `SESSION_SECRET` が不正なら、保護 API は 503 を返し、`/api/health` は 503 + `auth: "misconfigured"` を返す。データは返さない
- logout の cookie 削除は、発行時と同じ `Path` / `SameSite` / `Secure` を指定する

## 5. データソース

### 5.1 Codex

| 項目 | 内容 |
| --- | --- |
| Endpoint | `GET https://chatgpt.com/backend-api/wham/usage` |
| 認証 | コンテナ内の `/app/credentials/auth.json` の `openai-codex`（OAuth） |
| 窓の対応 | `limit_window_seconds` が 6 時間以下なら rolling、8 日以下なら weekly、それ以上は monthly |
| Header | `Authorization: Bearer <access>`、`chatgpt-account-id: <accountId>` |
| 使う値 | `plan_type`、`rate_limit.primary_window.used_percent`、`rate_limit.secondary_window.used_percent`、`rate_limit.limit_reached`、`credits.has_credits`、`rate_limit_reset_credits.available_count` |
| 保存しない値 | `email`、`user_id`、上流の生 JSON。`account_id` と token は Pi SDK 管理の `auth.json` にだけ置き、Portal の DB / API / 画面には出さない |

- `primary_window` / `secondary_window` は null を許容する。現在のプランでは片方だけ返る場合がある
- 枠の名前は固定値にせず、`limit_window_seconds` から作る（rolling / weekly / monthly）。値が読めない場合は rolling に寄せる
- **返ってきた窓だけを表示する**。週次が返らないアカウントでは週次の行を出さず、`—` や「利用不可」のプレースホルダーも出さない
- 読める窓が 1 つも無い場合は provider error とし、前回 snapshot を保持する
- `additional_rate_limits` は v1 の対象外。primary / secondary だけを見る
- `reset_at`（epoch 秒）を優先し、無ければ取得時刻 + `reset_after_seconds` を使う
- `rate_limit.limit_reached` が true、または `allowed` が false なら上限到達として扱う
- `credits.has_credits === true` のときだけクレジット残高を注記に出す
- `rate_limit_reset_credits.available_count > 0` のときだけリセット枠を注記に出す

#### 資格情報の管理

Portal は Codex の OAuth を自前で実装しない。Pi SDK の `ModelRuntime` を資格情報の読み取り・更新・サインインだけに使う。agent session は作らない。

```ts
const runtime = await ModelRuntime.create({
  authPath: join(credentialDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});

const auth = await runtime.getAuth("openai-codex", {
  minOAuthValidityMs: 15 * 60 * 1000,
});
```

- `PI_CODING_AGENT_DIR=/app/credentials` を設定する
- `modelsPath: null` を明示し、model store を書かない。`refreshOnCreate: false` と合わせて catalog のネットワーク更新も行わない
- device-id はアプリが `/app/credentials/device-id` に保存する。SDK の既定パスにも書かせない
- 起動時に `/app/credentials` を 0700、`auth.json` / `device-id` を 0600 にする。書けない場合は起動失敗にする
- `getAuth` は必要なら refresh し、Pi の `auth.json` 書き込みロック（`proper-lockfile`）の内側で保存する
- `accountId` は `readStoredCredential("openai-codex", authPath)` から取る。無ければ access token の JWT claim から取る
- サインインは `ModelRuntime.login("openai-codex", "oauth", interaction, { getDeviceId, agentName: "usage-portal" })`
- device id は `/app/credentials/device-id` に UUID で保存し、再起動しても同じ値を渡す
- `CredentialSynchronizationError` は、`providerId === "openai-codex"` かつ operation が login / logout と一致する場合だけ成功として扱う（auth.json への保存は済んでいるため）
- サインアウトは `ModelRuntime.logout("openai-codex")`。成功したら Codex の snapshot を削除し、sampler を起こす
- ホストの `~/.pi/agent` や u7agent の agent dir は共有しない。Portal 専用の `/app/credentials` を持つ
- Pi SDK は u7agent と同じバージョンに固定し、Dependabot の自動更新対象から外す

ホストの Pi 資格情報を共有しない理由は、2 つのプロセスが同じ refresh token を更新すると、ローテーションの競合で片方の認証が壊れるため。Portal が別ログインを持つが、ChatGPT の利用枠はアカウント単位なので表示される数値は同じになる。

### 5.2 Codex のサインインフロー

u7agent の「Sign in with ChatGPT」と同じく、Pi SDK の `ModelRuntime.login` が返すイベントを BFF が状態機械に写し、Web UI で操作する。u7agent の画面は `openai-codex` を許可リストから外している（SDK が `select` を求めるため）が、Portal は `select` を扱うので同じ仕組みを使える。

#### 状態

```ts
type CodexLoginState = {
  status: "running" | "succeeded" | "failed" | "cancelled";
  instructions: string | null; // auth_url.instructions の写し
  progress: string | null;
  authUrl: string | null;
  userCode: string | null;
  prompt:
    | { type: "select"; message: string; options: { id: string; label: string }[] }
    | { type: "manual_code"; message: string; placeholder: string | null }
    | null;
  error: string | null;
};
```

- `authUrl` は `running` の間だけ返す。成功・失敗・キャンセルで落とす
- `prompt` は `select` と `manual_code` だけを扱う。`text` / `secret` は「この画面では扱えないサインイン方式です」として失敗させる
- 受け付けるイベントは `auth_url` / `device_code` / `progress` だけ。`info` は無視する
- `instructions` はイベントではなく `auth_url.instructions` のフィールド。SDK の英語文はそのまま出さず、固定の日本語へ写す
- `progress.message` も SDK の英語文をそのまま出さず、既知の文言だけ日本語へ写す
- `manual_code` は待機中のときだけ受け付ける。`prompt.signal` が abort されたら入力欄を閉じ、以後の respond は 400/409 にする
- コールバックが先に完了した場合、`manual_code` の入力欄は出さない/閉じる。二重送信も拒否する
- SDK / provider の生の英語メッセージ、token は返さない。`client_id` は認可 URL に含まれる公開識別子であり、独立フィールドやログには出さない。失敗は固定文言に寄せる
- 進行中の二重開始は 409。キャンセルは冪等
- 開始から 10 分で自動中断し、コールバック待受を解放する
- 状態は BFF のメモリだけに持つ。再起動で消える
- 成功したら sampler を 1 回起こし、Codex カードをすぐ更新する

#### 操作

| Method | Path | 認証 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/codex/auth` | 必要 | `{ signedIn, login }`。`login` は進行中・終端状態 |
| POST | `/api/codex/login` | 必要 | サインイン開始。進行中の二重開始は 409 |
| POST | `/api/codex/login/respond` | 必要 | `{ value: string }`。`select` の選択肢 ID または貼り付け URL |
| DELETE | `/api/codex/login` | 必要 | 進行中のサインインを中断。終端状態は消す |
| POST | `/api/codex/logout` | 必要 | 保存済み OAuth を削除 |

#### 画面の流れ

```text
[Sign in with ChatGPT]
  ├─ select: Browser login / Device code login
  │    ├─ device_code: URL + コードを表示して待つ
  │    └─ auth_url: リンクを開く。届かない場合は最後の URL を貼り付け
  ├─ progress
  └─ succeeded / failed / cancelled
```

- スマホではデバイスコードを既定にする。ブラウザのコールバックはコンテナ内の `127.0.0.1:1455` に閉じ、ホストからも到達しないため、どのブラウザでも貼り付けで完了できるようにする
- 1455 は publish しない。ホストの Pi / Codex のログインと衝突するため
- ブラウザログインを選んだ場合も、貼り付け欄が出たらそれで完了できる
- 成功後は「サインインしました」と出し、認可 URL と入力欄を消す

### 5.3 OpenCode Go

| 項目 | 内容 |
| --- | --- |
| Endpoint | `GET https://opencode.ai/inference/go/v1/usage` |
| 認証 | `OPENCODE_API_KEY`（`.env`） |
| Header | `Authorization: <key>`（`Bearer` を付けない）、`Accept: application/json` |
| 使う値 | `usage.rolling`、`usage.weekly`、`usage.monthly` の `status` / `percent` / `resetsAt` |
| 保存しない値 | API key、上流の生 JSON |

- `percent` は 0〜100 の百分率として扱う（0.5 は 0.5%）
- 表示対象は `rolling` / `weekly` / `monthly` の 3 窓。API が返した窓をすべて表示し、欠損した窓は行を出さない（通常は 3 つ）
- `status` は parse の検証にだけ使い、`ok` 以外なら provider の `limitReached` / note に反映する。window の値は `percent` と `resetsAt` だけを持つ
- `resetsAt` は ISO 8601。parse できない場合はリセット時刻不明として扱う
- Cloudflare の判定を避けるため、`User-Agent: usage-portal/<version>` を明示する
- 401 / 403 は認証エラーとして扱い、キーの値をログや画面に出さない
- API key は静的。OPENCODE_API_KEY を変更したらコンテナを再作成する

### 5.4 上流 API の扱い

どちらの endpoint も、この用途向けの安定した公開契約として保証されているものではない。変更や制限を受けても画面全体を壊さないよう、provider ごとに adapter を分離する。

- 上流の JSON は `unknown` として受け、手書きの type guard で必要な項目だけ検証する
- 検証に失敗したら、その provider だけエラーにし、前回の snapshot を保持する
- 生の response body、token、email、account id はログに出さない
- HTTP status と所要時間だけをログに残す

## 6. 正規化モデル

Client は provider 固有の JSON を知らない。BFF が次の形に揃える。

```ts
type ProviderId = "codex" | "opencode-go";

type UsageWindow = {
  id: string;                 // "primary" | "rolling" | ...
  label: string;              // "ローリング" | "週次" | "月次"
  durationSeconds: number | null;
  usedPercent: number;        // 0-100。表示用に clamp する
  resetsAt: number | null;    // epoch ms
};

type ProviderSnapshot = {
  provider: ProviderId;
  name: string;               // "Codex" | "OpenCode Go"
  plan: string | null;        // "Plus" など
  capturedAt: number;         // epoch ms
  limitReached: boolean;
  windows: UsageWindow[];
  notes: string[];            // "リセット枠 2回" など、0 件なら空
};
```

- `usedPercent` は表示用に 0〜100 へ clamp する。上流が 100 超を返した場合は、clamp した値で表示し、`notes` に「上限超過」を出す
- `windows` には percent を読めた窓だけを入れる。読めなかった窓は配列自体に入れない
- `notes` は provider 固有の補足を画面に出すための短い文字列に限定する

### 枠のラベル

| provider | 元 | ラベル |
| --- | --- | --- |
| Codex | `primary_window` | `limit_window_seconds` が 6 時間以下なら「ローリング」、8 日以下なら「週次」、それ以上は「月次」 |
| Codex | `secondary_window` | 同上 |
| OpenCode Go | `rolling` | ローリング |
| OpenCode Go | `weekly` | 週次 |
| OpenCode Go | `monthly` | 月次 |

同じ provider 内でラベルが重複した場合は、短い方から「第1枠」「第2枠」を後ろに付ける。実際には発生しにくいが、表示の一意性を保つため。

`windows` 配列には percent を読めた窓だけを入れる。読めなかった窓は配列自体に入れず、画面も行を出さない。Codex の週次が無いアカウントでは週次行が無い状態が正常。

## 7. BFF と保存

### 7.1 構成

```text
src/
  server.ts                 # Bun.serve、HTML と /api/* の振り分け
  server/
    app.ts                  # Hono app、AppType
    config.ts               # env と既定値
    db.ts                   # SQLite の open / migrate / query
    sampler.ts              # 5 分ポーリング、single-flight
    state.ts                # snapshot と error から API 用 state を導出
    auth/
      pin.ts                # PIN の検証、PIN_HASH_B64 の decode
      session.ts            # cookie の署名・検証
      rate-limit.ts         # 失敗回数の sliding window
      middleware.ts         # 保護 API の認証
    codex-auth/
      runtime.ts            # ModelRuntime の生成と getAuth / logout
      login.ts              # サインインの状態機械
      routes.ts             # /api/codex/*
    providers/
      types.ts
      codex.ts
      opencode-go.ts
  client/
    main.tsx
    App.tsx
    components/
      LoginScreen.tsx
      ProviderCard.tsx
      UsageMeter.tsx
      StatusLabel.tsx
      Trend.tsx
      CodexAuthPanel.tsx
      SessionExpiryBanner.tsx
    lib/
      format.ts             # 残り時間、%、日時、期限日数
      status.ts             # しきい値とラベル
    styles.css
  scripts/
    hash-pin.ts
    generate-session-secret.ts
```

### 7.2 ポーリング

- 起動直後に 1 回取得し、その後 `POLL_INTERVAL_MS`（既定 300000 = 5 分）ごとに取得する。client のポーリング間隔はこれとは別で 60 秒固定
- provider は並列に取得する。片方が失敗しても、もう片方の結果は保存する
- single-flight とし、前回の取得が終わる前に次のタイマーが来たら開始しない
- 成功時: snapshot upsert、sample 追記、error 削除を 1 つの transaction で行う
- 失敗時: error upsert だけを行い、snapshot は保持する
- 起動時と 24 時間ごとに、30 日より古い `usage_sample` を削除する
- 終了時は interval を止め、DB を close する

### 7.3 SQLite

```sql
CREATE TABLE provider_snapshot (
  provider TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE provider_error (
  provider TEXT PRIMARY KEY,
  failed_at INTEGER NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE usage_sample (
  provider TEXT NOT NULL,
  window_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  used_percent REAL NOT NULL,
  resets_at INTEGER,
  PRIMARY KEY (provider, window_id, captured_at)
) WITHOUT ROWID;
```

- `snapshot_json` は正規化済みの `ProviderSnapshot` だけを保存する
- DB は `/app/data/usage.sqlite`（`DATA_DIR` で変更可）。起動時にディレクトリを 0700、ファイルを 0600 にする
- `umask 077` をプロセスの先頭で設定する
- `PRAGMA journal_mode = WAL`、`PRAGMA busy_timeout = 5000`
- migration は `PRAGMA user_version` で管理する。初版は version 1
- sample は 30 日保持する。24 時間の推移を描くために使い、保持期間は削除条件として 30 日

### 7.4 API

`GET /api/usage`

```json
{
  "generatedAt": 1760000000000,
  "sampleIntervalMs": 300000,
  "providers": [
    {
      "id": "codex",
      "name": "Codex",
      "plan": "Plus",
      "state": "ok",
      "capturedAt": 1760000000000,
      "error": null,
      "limitReached": false,
      "windows": [
        {
          "id": "primary",
          "label": "週次",
          "durationSeconds": 604800,
          "usedPercent": 62,
          "resetsAt": 1760300000000
        }
      ],
      "notes": ["リセット枠 2回"],
      "trend": {
        "windowId": "primary",
        "points": [
          { "at": 1759990000000, "usedPercent": 58 },
          { "at": 1759993600000, "usedPercent": 62 }
        ]
      }
    }
  ]
}
```

- `state` は `loading` / `ok` / `stale` / `error`
- `error` は `{ code, message, at }`。`code` は `not_connected` / `reauth_required` / `upstream` / `schema` / `config` の固定 enum。生の response body は入れない
- `trend` は点が 2 未満なら null
- `trend` は最新 snapshot で最も `usedPercent` が高い枠を対象にする。同値なら `durationSeconds` が短い方。sample を 30 分 bucket に丸め、最大 48 点にする
- provider の `plan` は、Codex の `plus` / `pro` などを表示用の `Plus` / `Pro` に写す。未知の値は raw のまま出す
- API は認証済みのとき常に 200 を返し、provider の失敗は payload の中の `state` / `error` で表す
- `Cache-Control: no-store`
- `GET /api/health` は `{ ok, service, db, auth }` を返す。DB の open と migration、認証設定が正常なときだけ 200、それ以外は 503。利用枠は返さない
- Codex の `error.code` が `not_connected` / `reauth_required` のとき、client は `/api/codex/auth` の結果とあわせて未接続 / 再サインインを出す
- client は起動時に `/api/codex/auth` を必ず取得する。ログイン中は 2 秒ごと、ログイン成功・ログアウト後は即時に取り直す

`state` の決め方:

| 条件 | state |
| --- | --- |
| snapshot なし、error なし | `loading` |
| snapshot なし、error あり | `error` |
| snapshot あり、error あり | `stale` |
| snapshot あり、error なし、`now - capturedAt > 2 * sampleIntervalMs` | `stale` |
| それ以外 | `ok` |

## 8. 画面

### 8.1 構成

1 ページだけ。ナビゲーション、設定、PIN 変更、アカウント切り替えは置かない。Codex の接続だけはカード内のパネルで行う。

- 未認証: PIN ログイン画面
- 認証済み: Header、セッション期限バナー、provider カード 2 枚、Footer
- Header: プロダクト名、対象の説明、自動更新と最終取得時刻、ログアウト
- Footer: 更新間隔と「表示専用」の注記

```text
未認証（中央寄せ）                  認証済み・広い画面（>= 900px）
┌───────────────────────┐         ┌──────────────────────────────────────────┐
│ [mark] Usage          │         │ [mark] Usage              [ログアウト]   │
│                       │         │ Codex / OpenCode Go                      │
│ PIN（6桁）            │         │ ● 自動更新             最終取得 12:34    │
│ [••••••          ]    │         ├─────────────────────┬────────────────────┤
│ [ログイン]            │         │ [C] Codex    Plus   │ [G] OpenCode Go    │
│                       │         │             利用可能 │              残りわずか│
│                       │         │ 週次            62% │ ローリング      35% │
└───────────────────────┘         │ ...                 │ ...                │
                                  └─────────────────────┴────────────────────┘
```

- 900px 未満は 1 列、900px 以上は 2 列。カードは同じ高さに揃える
- 最大幅は 1080px。広い画面でも横に伸ばしすぎない
- `100dvh` を基本にし、内容が長い場合はページ全体をスクロールさせる

### 8.2 ログイン画面

- 中央寄せ、最大幅 360px
- 見出し「PIN を入力」、補助文「6 桁の数字」
- `type="password"`、`inputmode="numeric"`、`pattern="[0-9]*"`、`maxlength=6`
- 6 桁になるまで送信ボタンを無効化する
- 送信中はボタンを無効化し、二重送信を防ぐ
- 失敗時は入力を消し、`role="alert"` で「PIN が違います」を出す
- ロック中は残り時間を表示し、送信を無効化する。カウントダウンは 1 秒ごと
- PIN は URL、localStorage、sessionStorage に置かない。コンポーネントの state だけに持つ
- 認証状態の確認中は、ログインフォームではなく読み込み表示を出す
- セッション切れで戻ってきた場合は「セッションが切れました。もう一度 PIN を入力してください」と出す
- 期限バナーから来た場合は「PIN を再入力すると 30 日間延長されます」と出す

### 8.3 セッション期限バナー

認証済みで `0 < expiresAt - now <= 3日` のとき、Header の下に出す。

```text
┌──────────────────────────────────────────────────────────┐
│ ログインの有効期限が近づいています（あと 2 日）  [PIN を再入力] │
└──────────────────────────────────────────────────────────┘
```

- 色は `attention`。アイコンと文言を併用する
- ボタンでログイン画面を再表示する。成功したら新しい cookie と `expiresAt` で置き換える
- 閉じるボタンは付けない
- 期限切れで 401 になったら、バナーではなくログイン画面へ切り替える

### 8.4 カード

```text
┌────────────────────────────────────┐
│ [provider mark] Codex      Plus    │
│                              [状態]│
│                                    │
│ 週次                          62%  │
│ ████████████░░░░░░░░               │
│ 残り 38% · リセット 10/31 09:00 · あと 3 日 │
│                                    │
│ 24時間の推移（週次）                │
│      ╱╲╱                           │
│                                    │
│ 最終取得 12:34 · リセット枠 2回     │
│ Codex の接続                       │
└────────────────────────────────────┘
```

- 見出し: provider 名（本文サイズ・600）、plan（補助文字）
- 状態ラベル: 右端。狭くて入らない場合は次の行へ送る
- 枠ごとに「ラベル」「使用率」「バー」「残りとリセット」を縦に並べる
- バーは高さ 8px、角丸 8px。track は `raised`、fill は `accent`。80% 以上は `attention`
- `role="progressbar"`、`aria-valuemin=0`、`aria-valuemax=100`、`aria-valuenow`、`aria-label` を付ける
- 使用率の数値は丸めて表示する。残りは `100 - usedPercent` を 0〜100 に clamp して表示する
- 80% 以上の行は、数値の前に注意記号を付ける（色だけに頼らない）
- リセットは「リセット 10/31 09:00 · あと 3 日」の 1 行。日時はブラウザのローカル時刻
- 「あと」は `まもなく` / `N 分` / `N 時間` / `N 日` を出し分ける。1 時間未満は分、24 時間未満は時間、それ以上は日
- 注記は 0 件なら行ごと出さない
- Codex カードの footer に「Codex の接続」を置き、サインイン / サインアウトのパネルを開く

### 8.5 状態

| 状態 | ラベル | 表示 |
| --- | --- | --- |
| `ok`、全枠 80% 未満 | 利用可能 | success |
| `ok`、いずれかの枠が 80% 以上 | 残りわずか | attention |
| 上限到達（`limitReached` または 100% 以上） | 上限到達 | attention |
| `stale` | 更新停止 | attention。前回の値は残す |
| `error` | 取得エラー | attention。空状態を出す |
| `loading` | 取得中 | neutral |
| Codex 未接続 | 未接続 | neutral。サインインを促す |
| Codex 再認証が必要 | 再サインイン | attention。サインインを促す |

- 色だけで区別しない。状態ラベルには記号（円 / 三角 / 四角 / 横線）と文言を付ける
- `stale` は「最後に成功した値」であることを明示する。`error` は値がないことを明示する
- エラー時は「5 分後に自動で再試行します」と添える。再試行ボタンは置かない
- Codex 未接続のカードは、利用枠の代わりに「Sign in with ChatGPT」を主操作として出す
- Codex の認証切れは「再サインインが必要です」と出し、同じパネルへ導く

### 8.6 Codex の接続パネル

カード内に展開する。モーダルにはしない（スマホで扱いやすい）。

```text
Codex の接続
┌────────────────────────────────────┐
│ [Sign in with ChatGPT]             │
│                                    │
│ サインイン方法                      │
│ ( ) デバイスコード（おすすめ）       │
│ ( ) ブラウザ                       │
│ [続ける]                           │
│                                    │
│ コード: ABCD-EFGH                  │
│ https://...                        │
│ [承認ページを開く] [コピー]         │
│                                    │
│ 別のブラウザで承認した場合          │
│ [最後の URL を貼り付け]             │
│                                    │
│ [中断]                             │
└────────────────────────────────────┘
```

- 未接続: 「Sign in with ChatGPT」を主操作
- `select`: SDK の選択肢を Portal 用のラベルに置き換えて出す。初期選択はデバイスコード
- `device_code`: URL、コード、コピー、承認ページを開くリンクを出す
- `auth_url`: `auth_url.instructions` があれば固定の日本語へ写して主文に出す。URL はリンクとして出す。コールバックが届かない場合は貼り付け欄を案内する
- `manual_code`: 最後の URL を貼り付ける入力欄を出す
- `progress`: SDK の `progress.message` を既知の文言だけ日本語へ写して補助行に出す
- `info`: 無視する
- 成功: 「サインインしました」と出し、認可 URL と入力欄を消す。カードを再取得する
- 失敗: 固定文言で出す。生の SDK エラーは出さない
- 進行中は「中断」を出す。二重開始はしない
- サインイン済み: 「サインアウト」を出す。サインアウト後は未接続表示に戻る

### 8.7 24 時間の推移

- 最新 snapshot で最も使用率が高い枠を 1 本の line chart にする
- SVG の `viewBox` は `0 0 100 28` 程度。y は 0〜100% 固定
- 線は `currentColor`、area は accent の低い不透明度。grid は置かない
- 点が 2 未満なら chart ごと出さない
- 見出しに「24時間の推移（週次）」のように対象の枠名を必ず出す
- chart は `aria-hidden="true"` にし、数値は上の meter が持つ。見出しはテキストで読めるようにする

### 8.8 文字と余白

- `hwc` の DESIGN スキルの foundations をそのまま使う
- 色は `prefers-color-scheme` に追従する。手動のテーマ切替は持たない
- 本文は狭い画面 1.0625rem、広い画面 0.9375rem
- 見出しは 1.75rem / 1.5rem、600
- 補助文字は 0.8125rem
- 余白は 4 / 8 / 12 / 16 / 20 / 24 / 32px
- カードの角丸は 16px、状態ラベルは 8px
- 影は使わず、`surface` と `line` で層を作る

### 8.9 アクセシビリティ

- 状態は色・記号・文言の 3 つで示す
- PIN 入力には表示ラベルを付け、エラーは `role="alert"` で関連付ける
- バナーは `role="status"` にし、ページ表示時に一度だけ読ませる
- 文字 200% でも meter の数値とリセットが読めるようにする
- リセットまでのカウントダウンは 30 秒ごとに更新するが、`aria-live` は付けない（連続読み上げを避ける）
- `prefers-reduced-motion` では transition を止める
- 読み込み中も、確定済みの前回値は理由なく消さない

## 9. セキュリティとプライバシー

- 認証情報は BFF と `/app/credentials` だけに置き、API レスポンス、HTML、SQLite に含めない
- Codex の `email`、`user_id`、`account_id` は Portal の DB / API / 画面には保存・表示しない。`auth.json` は Pi SDK 管理で token と accountId を含むため、0600 で保護し、ログ・応答・バックアップに出さない
- OpenCode の API key は Portal の DB / API / 画面には保存・表示しない
- 上流の生 JSON は保存しない。正規化した snapshot だけを保存する
- エラーログは HTTP status と provider 名だけにする。response body を出さない
- SQLite は `/app/data` に置き、`.gitignore` の対象にする。ディレクトリは 0700、ファイルは 0600 にする
- `/app/credentials/auth.json` は refresh token を持つ。ホスト側も 0600、ディレクトリは 0700 にする
- `.env` はホスト側で 0600。リポジトリ、Issue、ログ、スクリーンショットへ貼らない
- 画面は読み取り専用で、利用枠を変更する API を持たない。Codex の接続だけは例外
- API は `Cache-Control: no-store`。CORS は設定しない（同一 origin のみ）
- セキュリティヘッダー:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `style-src` の `'unsafe-inline'` は、進捗バーの幅を style 属性で渡すためだけに許可する。script の inline は許可しない

### 公開範囲と TLS

- 自宅 LAN または VPN からの利用を前提にし、`0.0.0.0:3001` で待ち受ける。インターネットへは公開しない
- この前提では HTTP のままでよい。PIN と cookie は LAN / VPN の外へ出ない
- PIN は「誰でも開ける状態を避ける」ための入口認証であり、通信の暗号化ではない。LAN 内の盗聴まで防ぐものではない
- 出先は VPN 経由で自宅 LAN に入る。VPN の外に公開する構成にはしない
- TLS 終端を前段に置く場合だけ `COOKIE_SECURE=1` と `TRUST_PROXY=1` を設定する。v1 では必須にしない
- 6 桁 PIN は総当たり耐性が低い。Argon2id とレート制限で補うが、インターネット公開には使わない。必要になったらパスキー / TOTP へ移す

## 10. テスト

`hwc` のテスト方針に合わせ、BFF と純関数を中心に自動テストする。DOM テストは書かず、見た目は Playwright CLI と目視で確認する。

### Unit

- PIN: `PIN_HASH_B64` の decode、6 桁の検証、Argon2id の verify、`$argon2id$` 以外の拒否、不正な設定
- Session: 署名・検証、改ざん、期限切れ、PIN 変更で無効になること、cookie 属性、`expiresAt` の返却
- Rate limit: 5 回でロック、15 分で解除、成功でリセット、Retry-After、`TRUST_PROXY=0` で `X-Forwarded-For` を無視、`TRUST_PROXY=1` で先頭を採用
- Session cookie の `Secure`: `COOKIE_SECURE=1`、`auto` + `TRUST_PROXY=1` + `X-Forwarded-Proto: https`、HTTP で付かないこと
- Auth middleware: 未認証 401、認証済み 200、`/api/health` は公開、Origin 不一致は 403
- セッション期限バナーの判定（4日 / 3日 / 1日 / 期限切れ）
- Codex login state machine: `select` / `auth_url` / `device_code` / `manual_code` / `progress`、`info` の無視、成功・失敗・キャンセル、二重開始 409、10 分タイムアウト、`text` / `secret` の拒否
- `manual_code` の待機中のみ受理、`prompt.signal` の abort、コールバック勝利後の遅延貼り付け拒否
- `CredentialSynchronizationError` の login / logout 成功扱い
- Codex credentials: 資格情報なし、`getAuth` 成功、refresh 失敗、`accountId` 欠落、logout 後の snapshot 削除
- Codex の parse: primary のみ、primary + secondary、null window、limit reached、reset credits、欠損値、0 窓は error
- OpenCode の parse: 3 窓、weekly 欠損、0.5% のような小数、不正な `resetsAt`、`status` が `ok` 以外
- 枠ラベルの導出、`limit_window_seconds` の欠損は rolling
- `state` の決定（loading / ok / stale / error）、`error.code` の enum
- 残り時間、残り %、日時の整形、`まもなく` / 分 / 時間 / 日の境界
- 24 時間 trend の downsample と、最も使用率が高い枠の選択
- sentinel を使った漏えい検証: token / email / API key / account id が API 応答、ログ、DB 行に含まれない。`client_id` は認可 URL に含まれるため、ログと独立フィールドに出ないことを検証する
- `COMMIT_HASH` が `User-Agent: usage-portal/<version>` に反映されること

### BFF / DB

- in-memory SQLite で migration、snapshot の upsert、error の upsert / 削除（`code` を含む）、sample の追記、transaction、30 日より古い sample の削除
- provider を注入した API テストで、片方の失敗がもう片方を壊さないこと
- 失敗時に前回 snapshot が返ること
- 認証切れの `error.code` が `not_connected` / `reauth_required` になり、token や email を含まないこと
- 認証設定が不正なとき、保護 API が 503 でデータを返さず、`/api/health` も 503 になること
- Codex login の API 契約（開始・respond・cancel・logout、進行中の二重開始 409、生のエラーを返さないこと）
- `/app/credentials` の 0700 と `auth.json` / `device-id` の 0600、volume 外にファイルを作らないこと

### Client

- `format.ts` / `status.ts` の純関数だけをテストする
- フック自体はテストしない

### 手動 / E2E

- Playwright CLI で 390px / 1280px、ライト / ダーク
- 未認証 → PIN 入力 → ダッシュボード → ログアウト
- PIN 誤り、ロックアウト、セッション切れ、期限バナー
- Codex 未接続 / サインイン方法の選択 / デバイスコード表示 / 貼り付け / 失敗
- 正常、stale、error、未取得の 4 状態
- 文字 200%、`prefers-reduced-motion`
- 実データでの疎通は手元で行い、CI では認証情報を使わない

### Docker / self-hosted-runner

- monorepo の Dockerfile に `AS test` と `AS final` を置く。test は `bun run check` を実行する
- `./scripts/check-licenses --target projects/usage-portal` が通ること
- `self-hosted-runner` の `pr-check` で `docker compose -f deploy/usage-portal.yml config -q` が通ること
- `tests/test_deploy_targets.py` の target / choice 一致が通ること
- deploy 後の `post_deploy_writable_paths` で `/app/data` と `/app/credentials` に書けること
- `docker compose ps` で healthcheck が healthy になること

## 11. 実装順と PR 分割

1. monorepo PR: Bun / Preact / Hono の最小構成、CSS トークン、`/api/health`、Dockerfile、README、ADR
2. monorepo PR: PIN 認証、セッション cookie、期限バナー、レート制限、ログイン画面
3. monorepo PR: Codex の資格情報（Pi SDK）、SiWC サインインの状態機械、接続パネル
4. monorepo PR: provider adapter、SQLite、sampler、`/api/usage`
5. monorepo PR: ダッシュボード、状態、ポーリング、24 時間 trend
6. monorepo: main へマージ後、CD で image が GHCR に push されることを確認する
7. self-hosted-runner PR: `deploy/usage-portal.yml`、`targets.json`、manual deploy choice、`docs/usage-portal.md`
8. 実機: `.env` 作成 → deploy → PIN ログイン → Codex サインイン → 表示確認

image push より先に self-hosted-runner の deploy 定義をマージすると pull に失敗するため、6 → 7 の順を守る。`design.md` と ADR は 1 の PR で入れる。

## 12. 参考実装

- `pi-console` の `src/pi_console/usage.py` — provider ごとの独立失敗、5 分キャッシュ、`stale`、HTTP status / 固定分類だけを返すエラー処理
- `pi-console` の `web/app.js` の usage 描画 — 値がある窓だけを出し、80% 以上を注意表示にし、`リセット MM/DD HH:MM · あと N 日` を出す
- `pi-console` の `docs/design.md` の「割当使用量（`/api/usage`）」— Codex の窓を `limit_window_seconds` で振り分ける契約
- `u7agent` の `server/src/oauth-login.ts` と `client/src/components/model-settings/OAuthSignInSection.tsx` — SiWC の進行状態、貼り付け、中断の扱い
- `u7agent` の `docs/model-settings.md` — OAuth のイベント（`auth_url` / `device_code` / `progress`）と許可リストの扱い

## 13. ADR 候補

| 決定 | 採用 | 採用しない案 | 理由 |
| --- | --- | --- | --- |
| 状態の取得 | BFF が 5 分ごとにポーリング、client は 60 秒ごとに GET | SSE / WebSocket | 変化が遅く、操作もない。再接続と差分適用のコストに見合わない |
| 保存 | SQLite に snapshot と 30 日分の sample | メモリのみ | 再起動後も前回値を出せ、24 時間の推移を描ける |
| Codex の認証 | 専用 agent dir + Pi SDK `ModelRuntime` + u7agent と同じ SiWC の Web サインイン | ホスト Pi の auth.json 共有 / OAuth 自前実装 / CLI サインイン | 共有は refresh token の競合を招く。自前実装はローテーションの保守コストが高い。CLI はスマホから扱いにくい |
| 使用量の表示 | `pi-console` と同じく、取得できた窓だけを出す。Codex の週次が無いアカウントでは行を出さない | 常に 3 窓を並べ、無い窓を `—` で出す | 実データに無い窓を「0%」や「利用不可」として見せると、利用枠の有無を誤解する |
| 入口の認証 | 6 桁 PIN + 署名 cookie + レート制限 + 期限バナー | 認証なし / Basic 認証 | 読み取り専用でも利用状況は見せたくない。ユーザー管理を持たずに済む |
| 公開範囲 | 自宅 LAN / VPN のみ、HTTP | インターネット公開 / TLS 必須 | 自宅 LAN と VPN の内側だけなら HTTP で足りる。TLS は必要になった時点で前段に置く |
| 配布 | monorepo image + self-hosted-runner Compose | Docker を使わない | 既存の手動デプロイ基盤に乗せる |
| スタイル | 素の CSS + CSS 変数 | Tailwind / CSS Modules | `hwc` と同じく依存を増やさず、Bun のバンドラで完結させる |

## 14. 決定事項

- プロジェクト名は `usage-portal`（`projects/portal` と区別する）
- 公開ポートは `3001`
- PIN は 6 桁、セッションは 30 日、残り 3 日でバナー
- Codex は Portal 専用の OAuth ログインを持つ（ホスト Pi とは共有しない）
- Codex のサインインは u7agent と同じ SiWC の仕組みを Web UI に置く
- Codex の資格情報管理に Pi SDK を入れる（image は大きくなる）
- 24 時間の推移を含める
- 対象は Codex 1 アカウント、OpenCode Go 1 キー
- 自宅 LAN / VPN 内の HTTP を前提とし、TLS 終端は v1 のスコープ外
