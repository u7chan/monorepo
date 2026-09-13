# AGENTS.md

モノレポの `projects/pi-agent-gui`。既存の `projects/aiagent` とは別物。Node.js 24 / pnpm 10.34.5。

pi SDK を BFF に埋め込んだ小さなブラウザ GUI。BFF は **Hono + TypeScript**（`server/`、入力検証は zod）、フロントエンドは Vite + React 19 + TypeScript + Tailwind CSS v4（`client/`）。client は `hono/client`（hc）で server の `AppType` を参照して型安全に API を呼ぶ。セッションとエージェント/スキル定義はメモリ内のみ（永続化しない）。作業用ツールはサンドボックス（別プロセス / 別コンテナ）へ分離済みで、BFF は子プロセスを起こさない。

## 検証

実装したら必ずこれを実行する。

```bash
pnpm check   # 型チェック + テスト + クライアントビルド
```

## コメント

why（コードから読めない理由・制約・落とし穴）だけを1〜2行で書き、what（コードを読めば分かる説明）は書かない。長い設計論は `docs/` へ移す。Issue / PR 番号はコメントに残さない（経緯は git 履歴と PR が持つ）。

## 参照

- [README.md](README.md) — 起動方法（`pnpm dev`）・環境変数・セキュリティ
- [docs/](docs) — 設計と API の詳細（architecture / api / persistence / ui-layout / migration）
