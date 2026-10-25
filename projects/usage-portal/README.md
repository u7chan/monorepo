# usage-portal

Codex（ChatGPT サブスクリプション）と OpenCode Go の利用枠を 1 ページで確認するダッシュボード。
自宅 LAN または VPN の内側から、スマホと PC で見る読み取り専用の画面で、Docker コンテナとして動かす。

全体設計は [docs/design.md](docs/design.md)、決定の理由は [docs/adr/](docs/adr) を参照する。

## この時点で入っているもの

設計の「実装順と PR 分割」の 1 番目（最小構成）に対応する。入っているのは次の範囲だけ。

- Bun + TypeScript + Preact + Hono の骨格と CSS トークン（`--up-` 接頭辞、`prefers-color-scheme` 追従）
- `GET /api/health`（DB と認証設定の状態だけを返す）
- SQLite の open と migration（v1 の DDL まで。保存も取得もしない）
- `Dockerfile`（`test` / `final`）

まだ無いもの: PIN ログイン、セッション cookie、利用枠の取得（`/api/usage`）、Codex のサインイン、provider カード、24 時間の推移。
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

`db` は SQLite の open と migration が通っているか、`auth` は後述の認証設定を読めるか。両方が `ok` のときだけ 200 で、それ以外は 503。
利用枠は返さない。応答には `Cache-Control: no-store` を付ける。

## 環境変数

`bun run dev` / `bun run start` はカレントディレクトリの `.env` を自動で読む（Bun の挙動）。雛形は [.env.example](.env.example)。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | `/app/data` | SQLite の置き場。起動時に 0700 で作り、配下の `usage.sqlite` を 0600 にする |
| `PIN_HASH_B64` | なし | `$argon2id$...` を base64url にした PIN ハッシュ。無い / 形が違えば `auth: misconfigured` |
| `SESSION_SECRET` | なし | セッション cookie の署名鍵。base64url で 32 bytes。無い / 長さが違えば `auth: misconfigured` |
| `COMMIT_HASH` | なし | build 時に埋め込む。`User-Agent: usage-portal/<version>` の version になる |

`PIN_HASH_B64` と `SESSION_SECRET` の作り方は [docs/design.md](docs/design.md) の認証の節を参照する。PIN を生成するコマンドは 2 番目の PR で入る。

## Docker

`test` ステージは `bun install --frozen-lockfile` の後に `bun run check` を実行する。`final` ステージは非 root（uid/gid 1000）で `bun src/server.ts` を起動する。

```bash
docker build --target test -t usage-portal-test ./projects/usage-portal
docker build --target final -t usage-portal-final ./projects/usage-portal

docker run --rm -p 3000:3000 \
  -e PIN_HASH_B64=<base64url> \
  -e SESSION_SECRET=<base64url 32 bytes> \
  -v "$PWD/data:/app/data" \
  usage-portal-final
```

`/app/data` はイメージ内で uid 1000 が書けるようにしてある。ホスト側のディレクトリをマウントするときは所有者を合わせる。

## ディレクトリ構成

```text
index.html                 HTML の入口（Bun が src/client/main.tsx をバンドルする）
src/server.ts              Bun.serve。HTML と /api/* の振り分け、DB と認証設定の初期化
src/server/app.ts          Hono app と AppType
src/server/config.ts       HOST / PORT / DATA_DIR / COMMIT_HASH
src/server/auth-config.ts  PIN_HASH_B64 / SESSION_SECRET の検証
src/server/db.ts           SQLite の open / migration / 権限
src/server/health.ts       /api/health の応答
src/server/version.ts      version と User-Agent の組み立て
src/client/main.tsx        Preact の骨格
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
- SQLite は `DATA_DIR`（0700）に置き、ファイルを 0600 にし、プロセスの先頭で `umask 077` を設定する
- `PIN_HASH_B64` / `SESSION_SECRET` / PIN をログに出さない
- 6 桁 PIN は総当たり耐性が低い。Argon2id とログイン試行の制限で補い、インターネット公開には使わない

## 参考

- [AGENTS.md](AGENTS.md) — このプロジェクトで作業するエージェント向けの規約
- [docs/design.md](docs/design.md) — 全体設計
- [docs/adr/0000-stack-and-style.md](docs/adr/0000-stack-and-style.md) — スタックとスタイル
- [docs/adr/0001-state-fetching.md](docs/adr/0001-state-fetching.md) — 状態の取得
- [docs/adr/0002-authentication-and-exposure.md](docs/adr/0002-authentication-and-exposure.md) — 入口の認証と公開範囲
