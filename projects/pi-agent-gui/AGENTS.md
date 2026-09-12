# AGENTS.md

モノレポの `projects/pi-agent-gui`。既存の `projects/aiagent` とは別物。Node.js 24 / pnpm 10.34.5を使い、依存更新はDependabotで追う。

pi SDK を BFF に埋め込んだ小さなブラウザ GUI。BFF は **Hono + TypeScript**（`server/`、入力検証は zod）で、フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4（`client/`）。client は `hono/client`（hc）で server の `AppType` を参照して**型安全に API 呼び出し**する。セッションとエージェント/スキル定義はメモリ内のみ（永続化しない）。

## コマンド

- `pnpm install` — 依存のインストール
- `pnpm build` — クライアントのプロダクションビルド（`client/dist/` に出力）
- `pnpm start` / `pnpm dev` — BFF 起動（http://127.0.0.1:4317。tsx で実行。`pnpm build` 済みの `client/dist/` を配信）
- `pnpm start:sandbox` / `pnpm dev:sandbox` — ツール実行サンドボックス起動（既定 :8080。BFF に `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が必要）
- `pnpm dev:web` — Vite 開発サーバー起動（http://localhost:5173、HMR 付き。`/api` は 4317 へプロキシ）
- `pnpm test` — node:test によるテスト（pi へのスタブを使用。実 API を呼ばないこと）
- `pnpm typecheck` — server / client 両方の `tsc --noEmit`
- `docker build --target test .` — 型チェック・テスト・フロントビルド（実APIは呼ばない）
- `docker build --target final -t pi-agent-gui:local .` — 配布イメージ。mainマージ後の既存CDでGHCRへpush

## 構成

- `server/src/app.ts` — Hono ルーティング / SSE / 静的配信（`client/dist/`）+ `AppType` export（client の型ソース）
- `server/src/index.ts` — BFF 起動エントリ（BFF の listen はこのファイルだけ）
- `server/src/sandbox/` — ツール実行サンドボックス（BFF と別プロセス / 別コンテナ）。`service.ts` 実行API、`client.ts` BFF側クライアント、`remote-tools.ts` リモートツール定義、`index.ts` 起動エントリ
- `server/src/sessions.ts` — セッションとラン（非同期実行）の管理
- `server/src/agent.ts` — pi SDK ランタイムの生成
- `server/src/agents.ts` — エージェント / スキル定義
- `server/src/schema.ts` — zod スキーマ + DTO 型（API 契約の正。client もここを参照する）
- `server/src/redact.ts` / `src/secret-guard.ts` — APIキー保護（マスク本体 / SDK接続）。ツール実行はサンドボックスへ分離済みで、BFF は子プロセスを起こさない
- `client/` — フロントエンド（Vite + React + TypeScript + Tailwind CSS v4）。レイアウトモード（desktop / portrait / landscape）は `src/lib/layout.ts` が判定する
- `server/test/` — node:test（pi はスタブ。listen せず `app.request()` で検証）
- `client/test/` — node:test（DOM を使わない純粋なロジックのみ。`client/src/hooks/settingsChange.ts` の応答適用ガードなど）

## コメント

コメントは why（コードから読めない理由・制約・落とし穴）だけを1〜2行で書き、what（コードを読めば分かる説明）は書かない。長い設計論は docs/ へ移す。

## ドキュメント

詳細は以下を参照。変更時は併せて更新すること。

- [README.md](README.md) — 使い方・環境変数
- [docs/architecture.md](docs/architecture.md) — 非同期実行とセッション管理の設計
- [docs/persistence.md](docs/persistence.md) — データの永続化範囲・再デプロイ時の挙動・将来の会話履歴DB化方針
- [docs/api.md](docs/api.md) — HTTP API リファレンス
- [docs/ui-layout.md](docs/ui-layout.md) — レイアウトモード（幅 / 高さ）の判定とモバイル向けシェル
