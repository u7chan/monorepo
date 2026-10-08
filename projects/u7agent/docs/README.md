# docs 索引

変更テーマから、読むべきコードと設計ドキュメントを引く。設計の全体像は [architecture.md](architecture.md)、起動と環境変数は [README.md](../README.md)（人間向け）を参照する。**何を docs に書くかの判断は [AGENTS.md](../AGENTS.md#docs) を参照する**（状態の一覧・件数・並び・既定値・実測値はコード / テストが正で、ここには書かない）。

| 変更テーマ | 主に読むコード | 主に読む docs |
| --- | --- | --- |
| デモ用スペース（会話専用・タブ別選択） | `server/src/spaces.ts`、`server/src/space-context.ts`、`server/src/app-paths.ts`、`client/src/SpacesApp.tsx`、`client/src/SpaceContext.ts` | [persistence.md](persistence.md#スペース)、[api.md](api.md#スペース)、[frontend.md](frontend.md#スペースの選択)、[ui-layout.md](ui-layout.md#スペース)、[testing.md](testing.md#スペースの受入) |
| ランの送信 / キュー / 停止 / SSE | `server/src/routes/sessions.ts`、`server/src/sessions.ts`、`server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md)、[api-sessions.md](api-sessions.md) |
| エージェントからユーザーへの質問カード（ask_user） | `server/src/ask-user-tool.ts`、`server/src/sessions.ts`、`client/src/lib/askUser.ts`、`client/src/components/chat/AskUserCard.tsx` | [ask-user.md](ask-user.md)、[api-sessions.md](api-sessions.md) |
| セッションの状態 / 履歴 / compaction 表示 | `server/src/session-record.ts`、`server/src/session-projection.ts`、`server/src/history-projection.ts`、`server/src/compaction-view.ts`、`server/src/session-payload.ts`、`client/src/lib/chatHistory.ts`、`client/src/lib/chatItems.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md)、[api-sessions.md](api-sessions.md) |
| HTTP の契約 / DTO / ルート追加 | `server/src/schema.ts`、`server/src/app.ts`、`server/src/routes/` | [api.md](api.md)、[api-sessions.md](api-sessions.md)、[api-catalog.md](api-catalog.md) |
| エージェント / スキル定義とファイルスキル | `server/src/agents.ts`、`server/src/catalog-skills.ts`、`server/src/file-skills.ts`、`server/src/builtin-skills.ts`、`server/src/session-skills.ts`、`client/src/components/AgentSettingsPage.tsx`、`client/src/components/SkillSettingsPage.tsx`、`client/src/components/composer/SkillPicker.tsx` | [api-catalog.md](api-catalog.md)、[api-sessions.md](api-sessions.md) |
| モデル / Effort の解決と変更 | `server/src/agent.ts`、`server/src/sessions.ts`、`client/src/lib/composerSettings.ts`、`client/src/lib/modelChoices.ts`、`client/src/lib/popoverPlacement.ts`、`client/src/components/composer/ModelEffortControls.tsx`、`client/src/components/composer/ComposerStatus.tsx` | [model-effort.md](model-effort.md)、[api-sessions.md](api-sessions.md) |
| モデル候補 / 既定モデル / プロバイダー API キー（設定 → モデル） | `server/src/model-settings.ts`、`server/src/routes/models.ts`、`server/src/app-db.ts`、`server/src/bootstrap.ts`、`client/src/hooks/useModelSettings.ts`、`client/src/lib/modelSettings.ts`、`client/src/components/ModelSettingsPage.tsx`、`client/src/components/model-settings/` | [model-settings.md](model-settings.md)、[secrets.md](secrets.md)、[api.md](api.md#利用可能なモデルとプロバイダーapiキー設定--モデル) |
| 画像生成（generate_image ツール / 画像APIキーの設定 / Markdown 画像のプレビュー） | `server/src/images.ts`、`server/src/image-tools.ts`、`server/src/image-settings.ts`、`server/src/routes/images.ts`、`server/src/agent.ts`、`client/src/components/markdown/MarkdownImageRefs.tsx` | [image-generation.md](image-generation.md)、[markdown.md](markdown.md#画像の-src-解決)、[api.md](api.md#画像生成設定--モデルの画像生成タブ) |
| Web 検索（web_search ツール / provider 抽象化 / 既定 provider とキーの設定） | `server/src/web-search-tool.ts`、`server/src/web-search-providers.ts`、`server/src/web-search-settings.ts`、`server/src/routes/web-search.ts`、`server/src/agent.ts`、`client/src/components/SelectMenu.tsx`、`client/src/hooks/useWebSearchSettings.ts`、`client/src/components/model-settings/WebSearchSettingsTab.tsx` | [web-search.md](web-search.md)、[api.md](api.md#web-検索の設定設定--モデルの-web-検索タブ) |
| プロジェクト / cwd / ファイルツリーとプレビュー | `server/src/projects.ts`、`client/src/components/FileTreePage.tsx`、`client/src/components/SessionFilesPanel.tsx`、`client/src/components/FileBrowser.tsx`、`client/src/components/RowMenu.tsx`、`client/src/components/FilePreview.tsx`、`client/src/lib/fileTree.ts`、`client/src/lib/fileTabs.ts`、`client/src/lib/fileRowMenu.ts`、`client/src/lib/fileRef.ts`、`client/src/lib/sessionFiles.ts`、`client/src/lib/chatScope.ts` | [projects.md](projects.md)、[api.md](api.md)、[ui-layout.md](ui-layout.md)、[file-preview.md](file-preview.md) |
| ファイル / フォルダのダウンロード（ZIP） | `server/src/archive-rules.ts`、`server/src/sandbox/zip.ts`、`server/src/sandbox/archive.ts`、`server/src/routes/files.ts`、`client/src/lib/archive.ts`、`client/src/lib/fileRowMenu.ts`、`client/src/components/FileBrowser.tsx` | [file-preview.md](file-preview.md#ダウンロード)、[api.md](api.md#ダウンロード)、[sandbox-api.md](sandbox-api.md#get-v1filesdownload) |
| アーカイブの除外（設定） | `server/src/archive-settings.ts`、`server/src/routes/archive.ts`、`server/src/app-db.ts`、`client/src/hooks/useArchiveSettings.ts`、`client/src/components/ArchiveSettingsPage.tsx`、`client/src/lib/archiveSettings.ts` | [api.md](api.md#アーカイブの除外名)、[persistence.md](persistence.md#アプリデータsqlite)、[file-preview.md](file-preview.md#ダウンロード) |
| セッションの保存・復元（会話ストア / 作業フォルダ） | `server/src/session-store.ts`、`server/src/sessions.ts`、`server/src/agent.ts` | [session-files.md](session-files.md)、[persistence.md](persistence.md) |
| ファイルプレビューの表示（行番号 / ハイライト / HTML・Markdown・画像の描画） | `client/src/lib/fileCode.ts`、`client/src/lib/fileTabs.ts`、`client/src/lib/markdownAsset.ts`、`client/src/lib/imageMeta.ts`、`client/src/lib/attachments.ts`、`client/src/components/FileBrowser.tsx`、`client/src/components/FilePreview.tsx`、`client/src/components/markdown/MarkdownFilePreview.tsx`、`server/src/routes/files.ts` | [file-preview.md](file-preview.md)、[api.md](api.md) |
| チャットの添付ファイル（アップロード / 画像配信 / 注記） | `server/src/attachments.ts`、`server/src/routes/sessions.ts`、`client/src/lib/attachments.ts`、`client/src/components/Composer.tsx`、`client/src/hooks/useU7Agent.ts` | [session-files.md](session-files.md)、[api-sessions.md](api-sessions.md) |
| 入力欄へのファイル参照（ツリーの行のドラッグ） | `client/src/lib/fileMention.ts`、`client/src/components/Composer.tsx`、`client/src/components/FileBrowser.tsx`、`client/src/components/SessionFilesPanel.tsx`、`server/src/agent.ts` | [file-preview.md](file-preview.md#ツリーの行のドラッグ入力欄への参照) |
| チャットのスキル一覧と `/skill:` の展開 | `server/src/session-skills.ts`、`server/src/sessions.ts`、`server/src/catalog-skills.ts`、`server/src/routes/sessions.ts`、`client/src/hooks/useSessionSkills.ts`、`client/src/lib/sessionSkills.ts`、`client/src/lib/skillPicker.ts`、`client/src/lib/skillBlock.ts`、`client/src/components/composer/SkillPicker.tsx`、`client/src/components/chat/SkillInvocation.tsx` | [api-sessions.md](api-sessions.md)、[persistence.md](persistence.md) |
| サンドボックス（ツール実行 / サービスの公開と起動・停止） | `server/src/sandbox/`、`server/src/serve.ts`、`server/src/service-proxy.ts`、`server/src/serve-tool.ts`、`server/src/routes/serve.ts`、`client/src/components/ServedAppStatus.tsx`、`client/src/hooks/useServeStatus.ts` | [sandbox.md](sandbox.md)、[sandbox-api.md](sandbox-api.md)、[api.md](api.md#サービスserveの状態と起動停止) |
| APIキーのマスク | `server/src/redact.ts`、`server/src/secret-guard.ts` | [secrets.md](secrets.md) |
| 作業フォルダの環境変数（変数 / シークレットの登録・暗号化・注入） | `server/src/secrets.ts`、`server/src/secret-crypto.ts`、`server/src/env-names.ts`、`server/src/routes/secrets.ts`、`server/src/serve.ts`、`server/src/sandbox/`、`client/src/components/EnvVarsTab.tsx`、`client/src/lib/sessionEnv.ts` | [secrets.md](secrets.md#作業フォルダの環境変数作業環境--環境変数)、[api.md](api.md#作業フォルダの環境変数作業環境--環境変数)、[persistence.md](persistence.md#アプリデータsqlite) |
| Discord 通知（会話ごとの On/Off と設定画面） | `server/src/notifications.ts`、`server/src/routes/notifications.ts`、`client/src/components/NotificationSettingsPage.tsx`、`client/src/components/notifications/` | [notifications.md](notifications.md) |
| フロントエンドの状態 / テーマ / レイアウト | `client/src/hooks/`、`client/src/theme/`、`client/src/components/` | [frontend.md](frontend.md)、[ui-layout.md](ui-layout.md) |
| チャットのツール履歴とライブ表示（実行中のツール / コピーの出し分け） | `client/src/lib/liveToolCall.ts`、`client/src/lib/toolSummary.ts`、`client/src/components/composer/LiveToolCall.tsx`、`client/src/components/chat/ToolHistory.tsx` | [frontend.md](frontend.md#チャット状態とレンダリング) |
| 検証（lint / format の設定と落とし穴） | `.oxlintrc.json`、`.oxfmtrc.json`、`client/src/lib/cn.ts`、`client/src/styles/index.css` | [verification.md](verification.md) |
| テスト方針 / client の検査の分類 / GUI 受入 | `client/test/`、`server/test/`、`AGENTS.md` | [testing.md](testing.md) |
| チャット本文の Markdown 描画 | `client/src/lib/markdown/`、`client/src/lib/codeLines.ts`、`client/src/components/markdown/` | [markdown.md](markdown.md)、[file-preview.md](file-preview.md#markdown-プレビュー) |
| 永続化 / 再デプロイ時の挙動 | - | [persistence.md](persistence.md) |
| 移植の経緯 | - | [migration.md](migration.md) |

## ドキュメントの構成

- [architecture.md](architecture.md) — 層構成・基本原則・責務の所在
- [run-lifecycle.md](run-lifecycle.md) — ラン、イベントログ、SSE、セッションのライフサイクル
- [ask-user.md](ask-user.md) — エージェントからユーザーへの質問カード（ツール契約・待機のライフサイクル・UI・mask 規則・既知の制限）
- [projects.md](projects.md) — プロジェクトとセッションの作業ディレクトリ
- [model-effort.md](model-effort.md) — モデル / Effort の解決と変更
- [model-settings.md](model-settings.md) — モデル候補（選択）/ アプリ既定モデルとプロバイダーAPIキーの GUI 設定（保存先・応答契約・degraded・残存リスク）
- [image-generation.md](image-generation.md) — 画像生成（保存先とパスの空間・キーによるゲート・失敗分類・キーの扱い・Markdown 画像のプレビュー）
- [web-search.md](web-search.md) — Web 検索（Exa / Tavily の provider 抽象化・引数と結果の整形・失敗の分類・実行時トグルとキーの設定）
- [sandbox.md](sandbox.md) — ツール実行のサンドボックス分離
- [sandbox-api.md](sandbox-api.md) — サンドボックス内部 API と環境変数（ZIP の除外規則と上限を含む）
- [secrets.md](secrets.md) — APIキー漏洩の抑制と、作業フォルダの環境変数（保存時暗号化・実行時注入）
- [notifications.md](notifications.md) — Discord 通知（送るタイミング・宛先制限・write-only な Webhook URL・設定画面）
- [frontend.md](frontend.md) — フロントエンドの契約（URL が画面の正・状態の所有と正・テーマと CSP・保存範囲・Effect 契約）
- [markdown.md](markdown.md) — チャット本文とファイルプレビューの Markdown 描画（対応サブセット・上限・インラインコードのファイル参照）
- [file-preview.md](file-preview.md) — ファイルプレビューの行番号・シンタックスハイライト・HTML / Markdown / 画像の描画と、ツリー行の ⋯ メニュー（削除 / リネーム / ダウンロード、除外名の設定を含む）
- [api.md](api.md) — HTTP API の規約と索引（health / files / projects）
- [api-sessions.md](api-sessions.md) — セッション API と SSE イベント
- [api-catalog.md](api-catalog.md) — エージェント / スキル API
- [compaction.md](compaction.md) — 会話の圧縮表示
- [persistence.md](persistence.md) — 永続化と再デプロイ
- [session-files.md](session-files.md) — セッション別ファイル管理・添付ファイル・会話の永続化の設計
- [ui-layout.md](ui-layout.md) — レイアウトモードの判定理由と、モード・導線・追従・入力欄・サイドバーの契約
- [verification.md](verification.md) — 検証（lint / format の設定と落とし穴）
- [testing.md](testing.md) — テスト方針と GUI の最小受入
- [migration.md](migration.md) — モノレポへの移植
