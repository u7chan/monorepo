# docs 索引

変更テーマから、読むべきコードと設計ドキュメントを引く。設計の全体像は [architecture.md](architecture.md)、起動と環境変数は [README.md](../README.md) を参照する。

| 変更テーマ | 主に読むコード | 主に読む docs |
| --- | --- | --- |
| ランの送信 / キュー / 停止 / SSE | `server/src/routes/sessions.ts`、`server/src/sessions.ts`、`server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md)、[api-sessions.md](api-sessions.md) |
| セッションの状態 / 履歴 / compaction 表示 | `server/src/session-record.ts`、`server/src/session-projection.ts`、`server/src/compaction-view.ts`、`server/src/session-payload.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md) |
| HTTP の契約 / DTO / ルート追加 | `server/src/schema.ts`、`server/src/app.ts`、`server/src/routes/` | [api.md](api.md)、[api-sessions.md](api-sessions.md)、[api-catalog.md](api-catalog.md) |
| エージェント / スキル定義 | `server/src/agents.ts`、`client/src/components/AgentSettingsPage.tsx`、`client/src/components/SkillSettingsPage.tsx` | [api-catalog.md](api-catalog.md) |
| モデル / Effort の解決と変更 | `server/src/agent.ts`、`server/src/sessions.ts`、`client/src/lib/composerSettings.ts` | [model-effort.md](model-effort.md)、[api-sessions.md](api-sessions.md) |
| プロジェクト / cwd / ファイルツリー | `server/src/projects.ts`、`client/src/components/FileTreePage.tsx`、`client/src/lib/fileTree.ts` | [projects.md](projects.md)、[api.md](api.md) |
| サンドボックス（ツール実行） | `server/src/sandbox/` | [sandbox.md](sandbox.md)、[sandbox-api.md](sandbox-api.md) |
| APIキーのマスク | `server/src/redact.ts`、`server/src/secret-guard.ts` | [secrets.md](secrets.md) |
| フロントエンドの状態 / テーマ / レイアウト | `client/src/hooks/`、`client/src/theme/`、`client/src/components/` | [frontend.md](frontend.md)、[ui-layout.md](ui-layout.md) |
| チャット本文の Markdown 描画 | `client/src/lib/markdown/`、`client/src/components/markdown/` | [markdown.md](markdown.md) |
| 永続化 / 再デプロイ時の挙動 | - | [persistence.md](persistence.md) |
| 移植の経緯 | - | [migration.md](migration.md) |

## ドキュメントの構成

- [architecture.md](architecture.md) — 層構成・基本原則・責務の所在
- [run-lifecycle.md](run-lifecycle.md) — ラン、イベントログ、SSE、セッションのライフサイクル
- [projects.md](projects.md) — プロジェクトとセッションの作業ディレクトリ
- [model-effort.md](model-effort.md) — モデル / Effort の解決と変更
- [sandbox.md](sandbox.md) — ツール実行のサンドボックス分離
- [sandbox-api.md](sandbox-api.md) — サンドボックス内部 API と環境変数
- [secrets.md](secrets.md) — APIキー漏洩の抑制
- [frontend.md](frontend.md) — フロントエンドの状態管理・テーマ・Effect 契約
- [markdown.md](markdown.md) — チャット本文の Markdown 描画（対応サブセットと上限）
- [api.md](api.md) — HTTP API の規約と索引（health / files / projects）
- [api-sessions.md](api-sessions.md) — セッション API と SSE イベント
- [api-catalog.md](api-catalog.md) — エージェント / スキル API
- [compaction.md](compaction.md) — 会話の圧縮表示
- [persistence.md](persistence.md) — 永続化と再デプロイ
- [ui-layout.md](ui-layout.md) — レイアウトモードの判定
- [migration.md](migration.md) — モノレポへの移植
