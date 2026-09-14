# ランのライフサイクルとセッション状態

エージェントの実行（ラン）は HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。イベント変換は `server/src/run-events.ts`、DTO 組み立ては `server/src/session-projection.ts` / `session-payload.ts` / `compaction-view.ts` に分かれる。実行・イベント・停止の原則は [architecture.md](architecture.md#基本原則) を参照する。

## ランのライフサイクル

```
POST /api/sessions/:id/messages { text }
  ├─ アイドル → SessionStore.startRun() → 202 { queued: false, runId }
  └─ 実行中   → キューに積む           → 202 { queued: true, queueDepth }
                    （キューは最大 10 件。超過は 429）

startRun():
  1. run オブジェクト生成（status: "running"）
  2. run_start イベントを記録
  3. session.subscribe() で pi のイベントを変換して記録（変換は `server/src/run-events.ts`）
     - message_update / text_delta → text
     - tool_execution_start/end    → tool_start / tool_end
     - agent_settled               → 終了判定
  4. session.prompt(text) を fire-and-forget で呼ぶ（await しない）
  5. agent_settled（または prompt の解決）で finish():
     - 最終テキストの取りこぼし補完（delta が来なかった場合の差分送出）
     - run.status を completed / stopped / error に確定
     - run_end イベントを記録
     - キューがあれば 200ms 後に pump() で次のメッセージを実行
```

## 状態

セッションの状態は `SessionStore.statusOf()` が導出する。

| 状態 | 意味 |
| --- | --- |
| `idle` | ランなし |
| `running` | ラン実行中 |
| `queued` | 待機メッセージあり |
| `completed` | 最後のランが完了 |
| `stopped` | 最後のランがユーザー停止 |
| `error` | 最後のランがエラー |

## イベントログと SSE

- ログは `{ seq, type, data, at }` の配列。セッションごとに直近 2000 件を保持。
- `GET /api/sessions/:id/events?after=N` が SSE 購読エンドポイント。イベント種別と data の契約は [api-sessions.md](api-sessions.md) を参照。
  - `seq > N` のエントリをリプレイしてからライブ配信に合流する。
  - 各イベントは `id: seq` 付きで送出するため、ブラウザの `EventSource` は自動再接続時に `Last-Event-ID` ヘッダを送り、サーバはこれを `after` のフォールバックとして使う。
  - クライアントのカーソルがバッファより古い（取りこぼしが埋められない）場合は、ログをリプレイせず `resync` イベント 1 件（セッション全体のペイロードを含む）を送り、クライアントは再描画する。
- 接続はハートビート（`: ping`、15 秒ごと）で維持する。購読は複数タブから可能で、切断してもランには影響しない。
- SSE で配るテキストは、マスク済みの値だけを載せる（[secrets.md](secrets.md)）。

## 会話履歴

- 履歴の正は pi セッション（`SessionManager.inMemory`）の `messages`。`GET /api/sessions/:id` が user / assistant のテキストに整形して返す。
- タイトルは最初のユーザーメッセージ（60 文字）から自動生成。セッション一覧 `GET /api/sessions` は状態・件数・最終使用時刻付きで返す。
- セッションの作成は最初のメッセージ送信時。未送信の新規チャットは `POST /api/sessions` を呼ばず、一覧にも出ない（エージェント切替・「新しい会話」・起動時の復元先無しはローカル状態のリセットだけで完結する）。作成前の Model / Effort 選択は次の作成時に `POST /api/sessions` の body として送られる。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。
- エージェント定義の編集・インポートは既存チャットに遡及しない。表示用のエージェント情報（名前・説明・スキル）は作成時に `SessionRecord` へスナップショット化し、定義の変更・削除後も `payload.agent` は作成時のままになる。
- 会話の圧縮（compaction）は `payload.compactions` と `compaction` / `resync` イベントで配る。表示仕様は [compaction.md](compaction.md) を正とする。

## 停止と破棄

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 待機キューを破棄し `queue_cleared` イベントを記録
2. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す）
3. `finish()` が `run_end`（status: `stopped`）を記録。キューは破棄済みなので次のランは起動しない

`DELETE /api/sessions/:id` は停止 + 破棄 + 購読者への `session_deleted` 通知を行う。

## ライフサイクル / 制限

- セッションとプロジェクトはプロセスのメモリ内のみ（[persistence.md](persistence.md)）。1 時間未使用のアイドルセッションは SWEEP で破棄（実行中・キューありは対象外）。
- サーバ終了時は全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。
