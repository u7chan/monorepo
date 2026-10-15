# herdr-mobile-client

Herdr と Pi CLI を LAN 内のスマホから操作する Web クライアントの PoC。

このプロジェクトは計画 ([#1882](https://github.com/u7chan/monorepo/issues/1882)) の PoC で、
現在はトークン認証つきのヘルス表示までを置く。Herdr 連携、会話表示は以降のステップで追加する。

- 認証は共有トークン（`Authorization: Bearer`）。与え方と残存リスクは [docs/auth.md](./docs/auth.md)
- スマホからの到達設定（Windows の portproxy とファイアウォール規則）は [docs/lan-access.md](./docs/lan-access.md)

## 必要環境

- Node.js 24 以上（`engines.node`）
- pnpm 10.34.5（`packageManager`）

## 起動方法

```bash
pnpm install

# 開発（Vite と API サーバーを同時に起動）
pnpm dev
# → クライアント: http://localhost:5173
# → API サーバー: http://localhost:18081（Vite が /api を proxy する）

# 本番相当（クライアントをビルドしてから Hono が配信する）
pnpm build
pnpm start
# → http://localhost:18081
```

`pnpm dev` では Vite が、`pnpm start` では Hono がトップページを配信する。
`pnpm start` はビルドをせず `tsx` でソースを実行するため、実行時依存だけを入れた状態でも起動できる。

その他のコマンド:

```bash
pnpm test       # node --test（test/*.test.ts）
pnpm typecheck  # tsc --noEmit
```

### ポート

| 環境変数 | 既定値 | 用途 |
| --- | --- | --- |
| `PORT` | `18081` | Hono（API サーバー）の待ち受け。Vite の proxy 先も同じ値 |
| `VITE_PORT` | `5173` | Vite の開発サーバー |

同じホストで 2 つ目の `pnpm dev` を起動するときは `PORT` と `VITE_PORT` を両方変える（例: `PORT=3100 VITE_PORT=5273 pnpm dev`）。
理由は [ADR 0001](./docs/adr/0001-dev-ports.md) を参照する。

### 認証

`/api/*` はすべてトークンを要求する。未設定なら起動のたびに生成され、起動ログに出る。
固定する場合は `HERDR_CLIENT_TOKEN` を渡す。

```bash
PORT=18081 HERDR_CLIENT_TOKEN='<固定値>' pnpm start
```

## 構成

- `src/client`: Preact + Tailwind のクライアント。`index.html` をエントリに Vite がビルドする
- `src/server`: Hono のサーバー。API を提供し、`dist/client` を配信する
- `test`: `node --test` のテスト
- `scripts`: 補助スクリプト（Windows 側の到達設定）
- `docs`: このプロジェクトのドキュメント。入口は [docs/README.md](./docs/README.md)

## ドキュメント

このプロジェクト固有のドキュメントは `docs/` に置く。モノレポ全体の文書はリポジトリ直下の `docs/` を参照する。
