# 全体構成

ブラウザ ⇄ BFF（`server/src/app.ts`、Hono）⇄ pi SDK（`server/src/agent.ts`）⇄ サンドボックス（`server/src/sandbox/`、ツール実行）という 4 層構成。エージェントの実行ライフサイクルは HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。LLM 認証情報は BFF 層までで止まり、サンドボックス層へは渡らない。

## 基本原則

1. **実行は裏で続く**: `POST /messages` は 202 で即時返却する。クライアントが切断されても、タブを閉じても、ラン（1 回の `session.prompt()`）は最後まで続く。
2. **イベントはセッション単位のログに積む**: 全イベントは連番（`seq`）付きでメモリ上のログに追記され、後から購読したクライアントに取りこぼしなくリプレイできる。
3. **停止は明示的に**: SSE 切断では止めない。`POST /stop` のみが実行を中断し、キューを破棄する。

## 責務の所在

| 責務 | 正 | 変更テーマ |
| --- | --- | --- |
| ラン / キュー / 購読 / セッション状態 | `server/src/sessions.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 会話ストア（永続化 / 復元） | `server/src/session-store.ts` | [session-files.md](session-files.md)、[persistence.md](persistence.md) |
| pi イベント → SSE イベント変換 | `server/src/run-events.ts` | [run-lifecycle.md](run-lifecycle.md) |
| 履歴 / payload / compaction の DTO 組み立て | `server/src/session-projection.ts`、`session-payload.ts`、`compaction-view.ts` | [run-lifecycle.md](run-lifecycle.md)、[compaction.md](compaction.md) |
| HTTP 契約（DTO の正） | `server/src/schema.ts` | [api.md](api.md) |
| ルートチェーンと `AppType` | `server/src/app.ts`、`server/src/routes/` | [api.md](api.md) |
| pi ランタイム / モデル解決 | `server/src/agent.ts` | [model-effort.md](model-effort.md) |
| プロジェクトと cwd | `server/src/projects.ts` | [projects.md](projects.md) |
| ツール実行のサンドボックス | `server/src/sandbox/` | [sandbox.md](sandbox.md) |
| 秘密値のマスク | `server/src/redact.ts`、`server/src/secret-guard.ts` | [secrets.md](secrets.md) |
| クライアント（状態 / テーマ / レイアウト） | `client/src/` | [frontend.md](frontend.md)、[ui-layout.md](ui-layout.md) |

セッション状態の所有者は `SessionStore` 1 つに保つ（create と project 削除・settings 変更中の送信抑止・queue / run / subscriber は複数箇所へ分けると競合を追えなくなる）。pi イベント変換と DTO 組み立ては純関数・アダプタとして外へ出し、ストア本体はライフサイクルだけを持つ。会話の読み書きは `session-store` へ出し、SDK セッションは `SessionManager.inMemory` + entries として扱う（ファイルは SDK に持たせない）。

## ドキュメントの読み方

変更テーマ別の入口は [README.md](README.md) の索引にまとめている。個別の設計は次のドキュメントを正とする。

- ランとセッション: [run-lifecycle.md](run-lifecycle.md)
- プロジェクトと cwd: [projects.md](projects.md)
- モデル / Effort: [model-effort.md](model-effort.md)
- サンドボックス: [sandbox.md](sandbox.md) / [sandbox-api.md](sandbox-api.md)
- APIキー保護: [secrets.md](secrets.md)
- フロントエンド: [frontend.md](frontend.md) / [ui-layout.md](ui-layout.md)
- 圧縮表示: [compaction.md](compaction.md)
- 永続化: [persistence.md](persistence.md)
