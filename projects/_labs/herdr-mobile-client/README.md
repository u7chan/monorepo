# herdr-mobile-client

Herdr と Pi CLI を LAN 内のスマホから操作する Web クライアントの PoC。

このプロジェクトは計画 ([#1882](https://github.com/u7chan/monorepo/issues/1882)) の第 1 段 ([#1991](https://github.com/u7chan/monorepo/issues/1991)) で、
実行・ビルド・型・テストが通る最小のひな型だけを置く。認証、Herdr 連携、会話表示は以降のステップで追加する。

## 必要環境

- Node.js 24 以上（`engines.node`）
- pnpm 10.34.5（`packageManager`）

## 起動方法

```bash
pnpm install

# 開発（Vite と API サーバーを同時に起動）
pnpm dev
# → クライアント: http://localhost:5173
# → API サーバー: http://localhost:3000（Vite が /api を proxy する）

# 本番相当（クライアントをビルドしてから Hono が配信する）
pnpm build
pnpm start
# → http://localhost:3000
```

`pnpm dev` では Vite が、`pnpm start` では Hono がトップページを配信する。どちらも `GET /api/health` が JSON を返す。

その他のコマンド:

```bash
pnpm test       # node --test（test/*.test.ts）
pnpm typecheck  # tsc --noEmit
```

### ポート

| 環境変数 | 既定値 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | Hono（API サーバー）の待ち受けポート。Vite の proxy 先も同じ値 |
| `VITE_PORT` | `5173` | Vite の開発サーバー |

同じホストで 2 つ目の `pnpm dev` を起動するときは、`PORT` と `VITE_PORT` を両方変える。
片方だけ変えると Vite の proxy 先とサーバーの待ち受けポートがずれ、`/api` が届かなくなる。

```bash
PORT=3100 VITE_PORT=5273 pnpm dev
```

### 実行時依存だけでの起動

`pnpm start` はビルドをせず `tsx` でソースを実行するため、`tsx` は `dependencies` に置いている。
`pnpm install --prod` で実行時依存だけを入れた状態でも `pnpm build` 済みの `dist/client` があれば `pnpm start` は動く
（クライアントのビルドには `devDependencies` の Vite が必要）。

```bash
pnpm install --prod
pnpm start
```

## 構成

```text
.
├── index.html              # Vite のエントリ
├── vite.config.ts          # Vite（/api を Hono へ proxy）
├── src/
│   ├── client/             # Preact + Tailwind
│   │   ├── main.tsx
│   │   ├── app.tsx
│   │   └── styles.css
│   ├── server/             # Hono
│   │   ├── index.ts        # 起動（PORT、dist/client の配信）
│   │   └── app.ts          # ルーティング（createApp）
│   └── shared/             # クライアントとサーバーで共有する型
│       └── health.ts
├── test/                   # node --test
├── docs/                   # このプロジェクトの設計メモ（リポジトリ直下の docs/ とは別）
└── dist/client/            # pnpm build の出力（Hono が配信）
```

## API

`GET /api/health` は Bridge 自身の情報だけを返す。Herdr の状態は以降のステップで追加する。

```json
{
  "ok": true,
  "version": "0.0.0",
  "startedAt": "2026-01-01T00:00:00.000Z"
}
```

## ドキュメント

このプロジェクトの設計メモと手順は `docs/`（このディレクトリ配下）に置く。
モノレポ全体の文書はリポジトリ直下の `docs/` を参照する。
