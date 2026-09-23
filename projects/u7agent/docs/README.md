# docs 索引

変更テーマから、読むべきコードと設計ドキュメントを引く。設計の全体像は [architecture.md](architecture.md)、起動と環境変数は [README.md](../README.md) を参照する。

| 変更テーマ | 主に読むコード | 主に読む docs |
| --- | --- | --- |
| ランの送信 / キュー / 停止 / SSE | `server/src/routes/sessions.ts`、`server/src/sessions.ts`、`server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md)、[api-sessions.md](api-sessions.md) |
| セッションの状態 / 履歴 / compaction 表示 | `server/src/session-record.ts`、`server/src/session-projection.ts`、`server/src/compaction-view.ts`、`server/src/session-payload.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md) |
| HTTP の契約 / DTO / ルート追加 | `server/src/schema.ts`、`server/src/app.ts`、`server/src/routes/` | [api.md](api.md)、[api-sessions.md](api-sessions.md)、[api-catalog.md](api-catalog.md) |
| エージェント / スキル定義とファイルスキル | `server/src/agents.ts`、`server/src/catalog-skills.ts`、`server/src/file-skills.ts`、`server/src/builtin-skills.ts`、`server/src/session-skills.ts`、`client/src/components/AgentSettingsPage.tsx`、`client/src/components/SkillSettingsPage.tsx`、`client/src/components/composer/SkillField.tsx` | [api-catalog.md](api-catalog.md)、[api-sessions.md](api-sessions.md) |
| モデル / Effort の解決と変更 | `server/src/agent.ts`、`server/src/sessions.ts`、`client/src/lib/composerSettings.ts`、`client/src/components/composer/ComposerStatus.tsx` | [model-effort.md](model-effort.md)、[api-sessions.md](api-sessions.md) |
| プロジェクト / cwd / ファイルツリーとプレビュー | `server/src/projects.ts`、`client/src/components/FileTreePage.tsx`、`client/src/components/SessionFilesPanel.tsx`、`client/src/components/FileBrowser.tsx`、`client/src/components/FilePreview.tsx`、`client/src/lib/fileTree.ts`、`client/src/lib/fileTabs.ts`、`client/src/lib/fileRef.ts`、`client/src/lib/sessionFiles.ts` | [projects.md](projects.md)、[api.md](api.md)、[ui-layout.md](ui-layout.md)、[file-preview.md](file-preview.md) |
| セッションの保存・復元（会話ストア / 作業フォルダ） | `server/src/session-store.ts`、`server/src/sessions.ts`、`server/src/agent.ts` | [session-files.md](session-files.md)、[persistence.md](persistence.md) |
| ファイルプレビューの表示（行番号 / ハイライト / HTML・画像の描画） | `client/src/lib/fileCode.ts`、`client/src/lib/fileTabs.ts`、`client/src/lib/attachments.ts`、`client/src/components/FileBrowser.tsx`、`client/src/components/FilePreview.tsx`、`server/src/routes/files.ts` | [file-preview.md](file-preview.md)、[api.md](api.md) |
| チャットの添付ファイル（アップロード / 画像配信 / 注記） | `server/src/attachments.ts`、`server/src/routes/sessions.ts`、`client/src/lib/attachments.ts`、`client/src/components/Composer.tsx`、`client/src/hooks/useU7Agent.ts` | [session-files.md](session-files.md)、[api-sessions.md](api-sessions.md) |
| チャットのスキル一覧と `/skill:` の展開 | `server/src/session-skills.ts`、`server/src/catalog-skills.ts`、`server/src/routes/sessions.ts`、`client/src/hooks/useSessionSkills.ts`、`client/src/lib/sessionSkills.ts`、`client/src/lib/skillBlock.ts`、`client/src/components/composer/SkillField.tsx`、`client/src/components/chat/SkillInvocation.tsx` | [api-sessions.md](api-sessions.md)、[persistence.md](persistence.md) |
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
- [markdown.md](markdown.md) — チャット本文の Markdown 描画（対応サブセット・上限・インラインコードのファイル参照）
- [file-preview.md](file-preview.md) — ファイルプレビューの行番号・シンタックスハイライト・HTML / 画像の描画
- [api.md](api.md) — HTTP API の規約と索引（health / files / projects）
- [api-sessions.md](api-sessions.md) — セッション API と SSE イベント
- [api-catalog.md](api-catalog.md) — エージェント / スキル API
- [compaction.md](compaction.md) — 会話の圧縮表示
- [persistence.md](persistence.md) — 永続化と再デプロイ
- [session-files.md](session-files.md) — セッション別ファイル管理・添付ファイル・会話の永続化の設計
- [ui-layout.md](ui-layout.md) — レイアウトモードの判定
- [migration.md](migration.md) — モノレポへの移植
