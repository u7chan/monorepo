# usage-portal

Codex（ChatGPT サブスクリプション）と OpenCode Go の利用枠を 1 ページで確認するダッシュボード。
自宅 LAN または VPN の内側から、スマホと PC で見る読み取り専用の画面で、Docker コンテナとして動かす。

全体設計は [docs/design.md](docs/design.md)、決定の理由は [docs/adr/](docs/adr) を参照する。

## この時点で入っているもの

設計の「実装順と PR 分割」の 1 番目（最小構成）と 2 番目（PIN 認証）に対応する。

- Bun + TypeScript + Preact + Hono の骨格と CSS トークン（`--up-` 接頭辞、`prefers-color-scheme` 追従）
- `GET /api/health`（DB と認証状態だけを返す）
- SQLite の open と migration（v1 の DDL まで。保存も取得もしない）
- 初回アクセスの PIN 登録、PIN ログイン、署名付きセッション cookie（30 日）、試行制限、期限バナー
- `Dockerfile`（`test` / `final`）

まだ無いもの: 利用枠の取得（`/api/usage`）、Codex のサインイン、provider カード、24 時間の推移。
順番は design.md の「実装順と PR 分割」に従う。

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

## 認証 API

| Method | Path | 内容 |
| --- | --- | --- |
| `GET` | `/api/auth/session` | `{ state: "setup_required" \| "unauthenticated" \| "authenticated", expiresAt? }`。常に 200 |
| `POST` | `/api/auth/setup` | `{ "pin": "123456" }`。PIN 未設定のときだけ受け付け、成功で cookie を発行（201） |
| `POST` | `/api/auth/login` | `{ "pin": "123456" }`。成功で cookie を発行（200）。失敗は 401、5 回失敗で 15 分ロック（429 + `Retry-After`） |
| `POST` | `/api/auth/logout` | cookie を消す（204） |

`POST` は `Origin` が同じ host のときだけ受け付ける。応答はすべて `Cache-Control: no-store`。

## 環境変数

`bun run dev` / `bun run start` はカレントディレクトリの `.env` を自動で読む（Bun の挙動）。雛形は [.env.example](.env.example)。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | `/app/data` | SQLite と認証状態（`pin-hash` / `session-key`）の置き場。起動時に 0700 で作り、配下のファイルを 0600 にする |
| `COMMIT_HASH` | なし | build 時に埋め込む。`User-Agent: usage-portal/<version>` の version になる |

PIN とセッション鍵は環境変数では渡さない。`DATA_DIR` 配下のファイルと初回セットアップで完結する。

## Docker

`test` ステージは `bun install --frozen-lockfile` の後に `bun run check` を実行する。`final` ステージは非 root（uid/gid 1000）で `bun src/server.ts` を起動する。

```bash
docker build --target test -t usage-portal-test ./projects/usage-portal
docker build --target final -t usage-portal-final ./projects/usage-portal

docker run --rm -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  usage-portal-final
```

`/app/data` はイメージ内で uid 1000 が書けるようにしてある。ホスト側のディレクトリをマウントするときは所有者を合わせる。
`data/` には `usage.sqlite`、`session-key`、初回セットアップ後の `pin-hash` が入る。これらを消すと PIN と履歴が初期化される。

## ディレクトリ構成

```text
index.html                 HTML の入口（Bun が src/client/main.tsx をバンドルする）
src/server.ts              Bun.serve。HTML と /api/* の振り分け、DB と認証の初期化
src/server/app.ts          Hono app と AppType、認証 API と同一 origin 検査
src/server/auth.ts         PIN の登録・照合とセッションの発行・検証
src/server/auth-store.ts   pin-hash / session-key の読み書きと権限
src/server/pin.ts          PIN の形式と Argon2id
src/server/session.ts      署名付き cookie の形式と検証
src/server/rate-limit.ts   ログイン試行の制限
src/server/config.ts       HOST / PORT / DATA_DIR / COMMIT_HASH
src/server/db.ts           SQLite の open / migration / 権限
src/server/health.ts       /api/health の応答
src/server/version.ts      version と User-Agent の組み立て
src/client/main.tsx        セットアップ / ログイン / ダッシュボードの骨格
src/client/api.ts          認証 API の呼び出しと応答の解釈
src/client/styles.css      CSS トークンと最小のレイアウト
test/                      bun:test
scripts/docs-check.mjs     docs の相対リンクとパスの検査
docs/design.md             設計（親 checkout からの写し）
docs/adr/                  決定の記録
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
- 画面は読み取り専用で、利用枠を変更する操作を持たない
- 認証情報と DB の中身は API から返さない。`/api/health` は状態だけを返し、利用枠や利用者情報を含めない
- SQLite と認証状態は `DATA_DIR`（0700）に置き、ファイルを 0600 にし、プロセスの先頭で `umask 077` を設定する
- PIN、PIN ハッシュ、セッション鍵、cookie をログに出さない
- セッション cookie は `HttpOnly; SameSite=Lax`。v1 は HTTP で LAN 内にだけ出すため `Secure` は付けない
- 6 桁 PIN は総当たり耐性が低い。Argon2id とログイン試行の制限で補い、インターネット公開には使わない

## 参考

- [AGENTS.md](AGENTS.md) — このプロジェクトで作業するエージェント向けの規約
- [docs/design.md](docs/design.md) — 全体設計
- [docs/adr/0000-stack-and-style.md](docs/adr/0000-stack-and-style.md) — スタックとスタイル
- [docs/adr/0001-state-fetching.md](docs/adr/0001-state-fetching.md) — 状態の取得
- [docs/adr/0002-authentication-and-exposure.md](docs/adr/0002-authentication-and-exposure.md) — 入口の認証と公開範囲
- [docs/adr/0003-pin-storage-and-session-key.md](docs/adr/0003-pin-storage-and-session-key.md) — PIN とセッション鍵の保存
