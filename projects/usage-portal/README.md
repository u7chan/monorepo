# usage-portal

Codex（ChatGPT サブスクリプション）と OpenCode Go の利用枠を 1 ページで確認するダッシュボード。
自宅 LAN または VPN の内側から、スマホと PC で見る画面で、Docker コンテナとして動かす。
利用枠の表示に加えて、設定したときだけ最小プロンプトを 1 回送る操作（Codex の 5 時間窓の開始と
OpenCode Go の接続確認）を持つ。

全体設計は [docs/design.md](docs/design.md)、決定の理由は [docs/adr/](docs/adr) を参照する。

## 機能

- Bun + TypeScript + Preact + Hono。CSS トークンは `--up-` 接頭辞で、`prefers-color-scheme` に追従する
- 初回アクセスの PIN 登録、PIN ログイン、署名付きセッション cookie（30 日）、試行制限、期限バナー
- BFF が 5 分ごとに Codex と OpenCode Go の利用枠を取り、SQLite に snapshot と sample を保存する
- 画面は 60 秒ごとに `/api/usage` を取得する。推移は窓ごとに描き、ローリング・週次・月次をタブで切り替える
- 表示は「簡易」と「標準」を切り替えられる。簡易は推移と補足を省いて 3 件程度を 1 画面に収め、選択は localStorage に残す（[ADR 0011](docs/adr/0011-view-mode-toggle.md)）
- 窓は月次 ⊃ 週次 ⊃ ローリングの入れ子で、外側が上限なら内側は「使用不可」と赤で出す（[ADR 0009](docs/adr/0009-window-blocking-and-five-hour-rolling.md)）
- Codex は Web UI から Sign in with ChatGPT（デバイスコード / ブラウザ + 貼り付け）でサインインする
- 送信の設定（モデルと思考レベル）を済ませると、Codex と OpenCode Go のカードの `⋮` に「接続確認」が出る。
  固定の最小プロンプトを 1 回だけ送り、応答本文は保存も表示もしない（[ADR 0017](docs/adr/0017-probe-prompts.md)）
- OpenCode Go はアカウント（API キー）を最大 10 件登録でき、1 アカウント = 1 カードで並べる
- PWA 用の manifest と 192 / 512px のアイコン、iOS ホーム画面用の 180px アイコンを配信する
- `GET /api/health` は DB と認証状態だけを返し、利用枠や利用者情報を含まない

`docs/design.md` は親 checkout の設計ドラフトの写しで、このプロジェクトでは書き換えない。実装との差分や決定は [docs/adr/](docs/adr) に置く。

## 起動

Bun 1.3 系を使う。`bun:sqlite` と HTML import に依存するため、Node.js では起動しない。

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
設定の判断は [ADR 0014](docs/adr/0014-pwa-icons.md) を参照する。

## 画面の読み方

ゲージの下の行は、先頭のバッジがリセットまでの残り時間（「あと 12 日」）、続く淡色の文字がリセット日時を表す。
すべての窓を使い切ったアカウントのカードは、一覧の末尾に回る。
表示の判断は [ADR 0008](docs/adr/0008-remaining-gauge-and-window-trend.md)、[ADR 0015](docs/adr/0015-reset-line-badge.md)、[ADR 0016](docs/adr/0016-exhausted-cards-last.md) を参照する。

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

| Method | Path | 認証 | 内容 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 不要 | `{ ok, service, db, auth }`。常に 200 か 503（利用枠は返さない） |
| `GET` | `/api/auth/session` | 不要 | `{ state: "setup_required" \| "unauthenticated" \| "authenticated", expiresAt? }`。常に 200 |
| `POST` | `/api/auth/setup` | 不要 | `{ "pin": "123456" }`。PIN 未設定のときだけ受け付け、成功で cookie を発行（201） |
| `POST` | `/api/auth/login` | 不要 | `{ "pin": "123456" }`。成功で cookie を発行（200）。失敗は 401、5 回失敗で 15 分ロック（429 + `Retry-After`） |
| `POST` | `/api/auth/logout` | 不要 | cookie を消す（204） |
| `GET` | `/api/usage` | 必要 | `{ generatedAt, sampleIntervalMs, sources[] }`。未認証は 401、認証設定が壊れていれば 503 |
| `GET` | `/api/codex/auth` | 必要 | `{ signedIn, login }`。`login` は進行中・終端のサインイン状態 |
| `POST` | `/api/codex/login` | 必要 | サインイン開始（202）。進行中の二重開始は 409 |
| `POST` | `/api/codex/login/respond` | 必要 | `{ "value": "..." }`。`select` の選択肢 ID か、ブラウザの最後の URL（204） |
| `DELETE` | `/api/codex/login` | 必要 | 進行中のサインインを中断（204、冪等） |
| `POST` | `/api/codex/logout` | 必要 | 保存済み OAuth を削除し、Codex の snapshot を消す（204） |
| `GET` | `/api/probe/models` | 必要 | `{ codex: [...], opencodeGo: [...] }`。`{ id, name, thinkingLevels, cost }`。ネットワークは叩かない |
| `GET` | `/api/codex/probe` | 必要 | `{ codex: { model, thinking } \| null }`。未設定は `null` |
| `PUT` | `/api/codex/probe` | 必要 | `{ model, thinking }` → 200 `{ codex }`。catalog に無ければ `invalid_model` / `invalid_thinking`（400） |
| `DELETE` | `/api/codex/probe` | 必要 | 設定を解除（200 `{ codex: null }`） |
| `POST` | `/api/codex/check` | 必要 | 最小プロンプトを 1 回送る → 200 `{ latencyMs }`。未設定は 409 `not_configured`、同時実行は 409 `in_progress` |
| `GET` | `/api/opencode/accounts` | 必要 | `{ accounts: [{ id, name, icon, savedAt, probeModel, probeThinking }] }`。キーは返さない |
| `POST` | `/api/opencode/accounts` | 必要 | `{ name, icon, apiKey, probeModel?, probeThinking? }` → 201 `{ account }`。検証して保存。失敗は `invalid_name` / `invalid_icon` / `invalid_key` / `invalid_probe` / `invalid_model` / `invalid_thinking`（400）、`limit_reached`（409）、`unavailable`（503） |
| `PUT` | `/api/opencode/accounts/:id` | 必要 | `{ name?, icon?, apiKey?, probeModel?, probeThinking? }` → 200 `{ account }`。未知の id は 404 |
| `POST` | `/api/opencode/accounts/:id/check` | 必要 | そのキーで最小プロンプトを 1 回送る → 200 `{ latencyMs }`。未知の id は 404、未設定は 409 `not_configured` |
| `DELETE` | `/api/opencode/accounts/:id` | 必要 | アカウントと snapshot / error / sample を削除（204）。未知の id は 404 |

状態を変える要求（`POST` / `PUT` / `DELETE`）は `Origin` が要求 URL と完全一致するときだけ受け付ける（`Origin` の無い要求も 403）。
応答はすべて `Cache-Control: no-store`。ログインの試行制限は接続元ごとに数え、同時に届いた要求も直列化して 5 回を超えて照合しない。

送信系の 2 つ（`/api/codex/check`・`/api/opencode/accounts/:id/check`）は同じ契約で失敗を返す。
401 / 403 は Codex が `reauth_required`、OpenCode Go が `invalid_key`、429 は `limit_reached`、400 / 404 は
`model_unavailable`、それ以外と stream の異常終了は `unavailable`。応答本文と上流のエラー文は返さない。
Codex の 5 時間窓が API に返らないアカウントがあるため、「開始済み」の判定は持たない（再送しても 5 時間は延びない）。

`sources[]` は source ごとに独立して失敗する。`id` は `codex` またはアカウントの uuid、`provider` は `codex` / 
`opencode-go`、`account` は OpenCode Go の `{ id, name, icon }`（Codex は `null`）で、並びは Codex → 登録順。
`state` は `loading` / `ok` / `stale` / `error`、`error.code` は `not_connected` / `reauth_required` / `upstream` / `schema` /
`config` の固定値で、上流の本文は含まない。未サインインの Codex は `not_connected` になり、画面では「未接続」と出す。

## Codex のサインイン

Codex の OAuth は自前実装せず、Pi SDK（`@earendil-works/pi-coding-agent`）の `ModelRuntime` を資格情報の
読み取り・更新・サインインだけに使う。資格情報は `CREDENTIAL_DIR`（既定 `/app/credentials`）に置き、ホストの
`~/.pi/agent` とは共有しない（同じ refresh token を 2 プロセスで更新すると片方が壊れるため）。

1. Codex カードの「Sign in with ChatGPT」を押す
2. サインイン方法を選ぶ（既定はデバイスコード。ブラウザを選んだ場合は最後の URL を貼り付けて完了する）
3. 表示された URL とコードで承認する
4. 成功すると `auth.json` に保存され、sampler が 1 回走って Codex カードが更新される

サインアウトはカード右上の `⋮` から行う（サインイン済みのときだけ出る）。未接続・再サインインのときの
「Sign in with ChatGPT」は、カードの中に残る。

コールバックポート（1455）は publish しない。コンテナ内の `127.0.0.1` に閉じるため、どのブラウザからでも
デバイスコードか貼り付けで完了できるようにしてある。進行中の状態は BFF のメモリだけに置き、開始から 10 分で自動中断する。

## 最小プロンプトの送信

Codex の「接続確認」と OpenCode Go の「接続確認」は、どちらも固定の 1 文（`Reply with the single word OK.`）を
1 回だけ送る。応答本文は使わず、成功・失敗・latency・固定のエラーコードだけを扱う（[ADR 0017](docs/adr/0017-probe-prompts.md)）。

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
3. 受け付けられなければ入力欄の下に理由が出る。アカウントは保存されない
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

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | `/app/data` | SQLite と認証状態（`pin-hash` / `session-key`）、送信の設定（`settings.json`）の置き場。起動時に 0700 で作り、配下のファイルを 0600 にする |
| `CREDENTIAL_DIR` | `/app/credentials` | Codex の `auth.json` / `device-id` と OpenCode Go の `opencode-accounts.json` の置き場。起動時に 0700、配下のファイルを 0600 にする |
| `POLL_INTERVAL_MS` | `300000` | 上流を取りに行く間隔。1 分未満・非整数は起動しない |
| `COMMIT_HASH` | なし | build 時に埋め込む。`User-Agent: usage-portal/<version>` の version になる |

`PI_CODING_AGENT_DIR` は Dockerfile で `CREDENTIAL_DIR` と同じ値にしている。PIN とセッション鍵は環境変数では渡さない。

## Docker

`test` ステージは `bun install --frozen-lockfile` の後に `bun run check` を実行する。`final` ステージは非 root（uid/gid 1000）で `bun src/server.ts` を起動する。

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
- `credentials/` には Codex の `auth.json`（refresh token と account id）、`device-id`、OpenCode Go の `opencode-accounts.json`（API キーとアカウント名）が入る。**バックアップやログに出さない**

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
src/server/sampler.ts         5 分ごとの取得（single-flight）と 30 日保持
src/server/usage.ts           /api/usage の応答（state と trends）の組み立て
src/server/state.ts           snapshot と error から state を決める
src/server/trend.ts           窓の期間と、推移の downsample
src/server/health.ts          /api/health の応答
src/server/version.ts         version と User-Agent の組み立て
src/server/providers/         Codex / OpenCode Go の adapter と正規化モデル
src/server/codex/             Pi SDK の資格情報、SiWC の状態機械、/api/codex/*
src/server/opencode/          OpenCode Go のアカウントの保存と /api/opencode/*
src/server/probe/             送信の設定（settings.json）、モデル catalog、最小プロンプトの送信
src/shared/                    server と client で共有する入力規則（アカウント名・アイコン・キー）
src/client/main.tsx           Preact の描画入口
src/client/App.tsx            セッション・利用枠・アカウントの取得と画面の切り替え
src/client/api.ts             API の呼び出しと応答の解釈
src/client/lib/format.ts      残り時間・%・日時の整形
src/client/lib/chart.ts       推移の縦軸レンジと横軸の目盛り
src/client/lib/windows.ts     推移の初期表示に選ぶ窓
src/client/lib/view-mode.ts  簡易 / 標準の保存値（localStorage）
src/client/lib/status.ts      状態ラベルとしきい値
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

- 自宅 LAN または VPN の内側からだけ使う。インターネットへ公開しない。v1 は HTTP のままで、TLS 終端は置かない
- 画面は利用枠を変更しない。資格情報（Codex のサインイン、OpenCode Go のアカウント）の登録・変更・削除と、
  明示的に押したときの最小プロンプト 1 回の送信だけを行う（送るのはサーバ側の固定 1 文で、利用者の入力は混ぜない）
- 認証情報と DB の中身は API から返さない。`/api/health` は状態だけを返し、利用枠や利用者情報を含めない
- SQLite と認証状態は `DATA_DIR`（0700）に置き、ファイルを 0600 にし、プロセスの先頭で `umask 077` を設定する
- Codex の token・account id・email、OpenCode の API key は応答・ログ・DB に残さない。上流の応答本文も保存しない
- 送信の成否は status・`stopReason`・latency・固定のエラーコードだけを扱い、プロンプトも応答も保存しない
- `/app/credentials` は 0700、`auth.json` / `device-id` / `opencode-accounts.json` は 0600。ホストの Pi 資格情報とは共有しない
- `opencode-accounts.json` はアカウント数だけキーを平文で持つ。旧 `opencode-key.json` を残すとキーが二重に残るため、登録後に削除する
- PIN、PIN ハッシュ、セッション鍵、cookie、API key、token をログに出さない
- セッション cookie は `HttpOnly; SameSite=Lax`。v1 は HTTP で LAN 内にだけ出すため `Secure` は付けない
- 6 桁 PIN は総当たり耐性が低い。Argon2id とログイン試行の制限で補い、インターネット公開には使わない

## 参考

- [AGENTS.md](AGENTS.md) — このプロジェクトで作業するエージェント向けの規約
- [docs/design.md](docs/design.md) — 全体設計
- [docs/adr/0000-stack-and-style.md](docs/adr/0000-stack-and-style.md) — スタックとスタイル
- [docs/adr/0001-state-fetching.md](docs/adr/0001-state-fetching.md) — 状態の取得
- [docs/adr/0002-authentication-and-exposure.md](docs/adr/0002-authentication-and-exposure.md) — 入口の認証と公開範囲
- [docs/adr/0003-pin-storage-and-session-key.md](docs/adr/0003-pin-storage-and-session-key.md) — PIN とセッション鍵の保存
- [docs/adr/0004-usage-sampling-and-storage.md](docs/adr/0004-usage-sampling-and-storage.md) — 利用枠の取得と保存
- [docs/adr/0005-codex-credentials-and-sign-in.md](docs/adr/0005-codex-credentials-and-sign-in.md) — Codex の資格情報とサインイン
- [docs/adr/0006-opencode-api-key-registration.md](docs/adr/0006-opencode-api-key-registration.md) — OpenCode Go の API キーの画面登録
- [docs/adr/0007-opencode-multiple-accounts.md](docs/adr/0007-opencode-multiple-accounts.md) — OpenCode Go の複数アカウント
- [docs/adr/0008-remaining-gauge-and-window-trend.md](docs/adr/0008-remaining-gauge-and-window-trend.md) — 残量ゲージと窓の期間に合わせた推移
- [docs/adr/0009-window-blocking-and-five-hour-rolling.md](docs/adr/0009-window-blocking-and-five-hour-rolling.md) — 窓の停止表示とローリングの 5 時間
- [docs/adr/0010-menu-and-modal-layout.md](docs/adr/0010-menu-and-modal-layout.md) — 常設ボタンのメニュー移動と追加のモーダル
- [docs/adr/0011-view-mode-toggle.md](docs/adr/0011-view-mode-toggle.md) — 簡易 / 標準の表示切り替え
- [docs/adr/0012-codex-signout-in-card-menu.md](docs/adr/0012-codex-signout-in-card-menu.md) — Codex のサインアウトをカードのメニューへ
- [docs/adr/0013-meter-status-icons.md](docs/adr/0013-meter-status-icons.md) — 使用不可と残りわずかの印を SVG にする
- [docs/adr/0014-pwa-icons.md](docs/adr/0014-pwa-icons.md) — PWA と iOS ホーム画面用のアイコン
- [docs/adr/0015-reset-line-badge.md](docs/adr/0015-reset-line-badge.md) — リセット行の残り時間をバッジにする
- [docs/adr/0016-exhausted-cards-last.md](docs/adr/0016-exhausted-cards-last.md) — 使い切ったカードを末尾に回す
- [docs/adr/0017-probe-prompts.md](docs/adr/0017-probe-prompts.md) — 最小プロンプトの送信（5 時間窓の開始と接続確認）
