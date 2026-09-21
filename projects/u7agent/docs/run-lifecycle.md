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
- `GET /api/sessions/:id/events` が SSE 購読エンドポイント。イベント種別と data の契約は [api-sessions.md](api-sessions.md) を参照。
  - SSE の `id` は `<generation>:<seq>`。`generation` は record のロードごとに発行する 8 hex で、再起動や sweep 後の復元で変わる。seq は復元で 0 に戻るため、数値カーソルだけでは古いタブの位置を判別できない。
  - カーソルの優先順位は `Last-Event-ID` ヘッダ → query の `generation` + `after` → `resync`。generation が一致し、seq がバッファ範囲内のときだけ差分をリプレイし、それ以外はセッション全体のペイロードを持つ `resync` を 1 件送る。
- 接続の生存確認は可視イベントの `ping`（接続直後と 15 秒ごと、`id` 無し = カーソルを動かさない）で行う。購読は複数タブから可能で、切断してもランには影響しない。
- SSE で配るテキストは、マスク済みの値だけを載せる（[secrets.md](secrets.md)）。

## 会話履歴

- 履歴の正は pi セッションの `messages` で、その永続化は BFF 専用ストアの `session.jsonl`（pi SDK 形式）が持つ（[persistence.md](persistence.md) / [session-files.md](session-files.md)）。`GET /api/sessions/:id` が user / assistant のテキストに整形して返す。
- BFF は起動時にストアを走査して一覧（meta ベースの descriptor）を作り、セッションを開いたとき（GET / POST messages / SSE）に SDK セッションを遅延生成する。未ロードのセッションは SDK を必要としない。
- タイトルは最初のユーザーメッセージ（60 文字）から自動生成し、meta へ保存する。セッション一覧 `GET /api/sessions` は状態・件数・最終使用時刻付きで返す。
- セッションの作成は最初のメッセージ送信時。未送信の新規チャットは `POST /api/sessions` を呼ばず、一覧にも出ない（エージェント切替・「新しい会話」・起動時の復元先無しはローカル状態のリセットだけで完結する）。作成前の Model / Effort 選択は次の作成時に `POST /api/sessions` の body として送られる。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。
- エージェント定義の編集・インポートは既存チャットに遡及しない。表示用のエージェント情報は作成時に `SessionRecord` へ、実行用プロンプトは meta の `promptSnapshot` へスナップショット化し、定義の変更・削除後も `payload.agent` と復元後の実行内容は作成時のままになる。
- 会話の圧縮（compaction）は `payload.compactions` と `compaction` / `resync` イベントで配る。表示仕様は [compaction.md](compaction.md) を正とする。compaction entry も `session.jsonl` に保存され、復元後も区切りが再現される（`reason` / `estimatedTokensAfter` は復元後は欠ける）。

## 停止と破棄

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 待機キューを破棄し `queue_cleared` イベントを記録
2. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す）
3. `finish()` が `run_end`（status: `stopped`）を記録。キューは破棄済みなので次のランは起動しない

`DELETE /api/sessions/:id` は停止 + ストアの履歴削除 + 購読者への `session_deleted` 通知を行う（作業フォルダは残す）。未ロードのセッションは SDK を開かずに消せる。

## ライフサイクル / 制限

- 会話は BFF 専用ストアへ永続化し、起動時に一覧を復元する（[persistence.md](persistence.md)）。プロジェクトの登録はプロセスのメモリ内のみで、所属は `projectCwd` から読み取り時に解決する。
- 1 時間未使用のアイドルセッションは SWEEP でメモリから外す（実行中・キューあり・SSE 購読中は対象外）。ストアと作業フォルダは残り、次回アクセス時に SDK セッションを復元する。
- id ごとの状態（未ロード / loading / live / evicting / deleting）とライフサイクルの Promise チェーンで、ロード・sweep・削除の競合を直列化する。読み書きするファイルは `session-store` の書込みキューでも直列化する。
- サーバ終了時は進行中の書込みを flush してから全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。
