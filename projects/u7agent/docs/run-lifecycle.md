# ランのライフサイクルとセッション状態

エージェントの実行（ラン）は HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。イベント変換は `server/src/run-events.ts`、DTO 組み立ては `server/src/session-projection.ts` / `session-payload.ts` / `compaction-view.ts` に分かれる。実行・イベント・停止の原則は [architecture.md](architecture.md#基本原則) を参照する。

## ランのライフサイクル

```
POST /api/sessions/:id/messages { text }
  ├─ アイドル → SessionStore.startRun() → 202 { queued: false, runId }
  └─ 実行中   → キューに積む           → 202 { queued: true, queueDepth }
                    （キューは最大 10 件。超過は 429）

startRun():
  1. run オブジェクト生成（status: "running", totalRetryCount: 0）
  2. run_start イベントを記録
  3. session.subscribe() で pi のイベントを変換して記録（変換は `server/src/run-events.ts`）
     - message_update / text_delta → text
     - tool_execution_start/end    → tool_start / tool_end
     - auto_retry_start/end        → run_retry / status（後述）
     - entry_appended(context_edit) → 失敗試行の取り消し resync（後述）
     - agent_settled               → 終了判定
  4. session.prompt(text) を fire-and-forget で呼ぶ（await しない）
  5. agent_settled（または prompt の解決）で finish():
     - 失敗試行の取り消し後の最終テキスト補完（対象はこのランで観測した assistant だけ）
     - run.status を completed / stopped / error に確定
     - run_end イベントを記録
     - キューがあれば 200ms 後に pump() で次のメッセージを実行
```

## 自動再試行（SDK の retry）

モデルの一時的なレート制限などは、pi SDK の agent-level リトライ（`SettingsManager` の `retry: { enabled: true, maxRetries: 2 }`）に任せる。**BFF は `prompt()` を再発行しない**（ユーザーメッセージやツール実行を二重に走らせない）。backoff は SDK の指数バックオフで、既定は 2 秒 → 4 秒。プロバイダーの `Retry-After` ヘッダーや本文の「Please try again in Xs」は SDK では使われないため、待機時間を上流の指定として保証しない。

SDK v0.87.1 で観測する順序（スタブではなく SDK 実体の回帰テストで固定）:

```text
message_end(assistant, error, usage.total = 0)  失敗試行
  → agent_end(willRetry=true)                   status「再試行を準備中…」
  → auto_retry_start { attempt, maxAttempts, delayMs } → run_retry(waiting)
  → entry_appended(context_edit)                失敗メッセージの投影からの除外
  → （backoff）
  → agent_start → message_start(assistant)       → run_retry(retrying)
  → message_end(assistant)
  → auto_retry_end { success, attempt }
```

- `waiting` は `auto_retry_start` で入り、`retryAt = 受信時刻 + delayMs` をサーバー基準で持つ。`retrying` は**次の assistant の `message_start`** を再実行開始の観測点にする。`auto_retry_end` は系列の確定（成功 / 最終失敗 / 中止）であって待機終了の通知ではない。
- `run.retry.attempt` は SDK が現在の連続失敗系列へ付けた番号で、成功するとリセットされる（同一ラン内の後続 LLM 呼び出しで再び 1 から始まる）。ラン全体の再試行回数は `run.totalRetryCount` が持ち、`auto_retry_start` の通知数の累計（**スケジュール回数**）と定義する。待機中に中止した回も含み、実際の HTTP 再送回数とは呼ばない。終了時はアクティブな `retry` だけを消し、累計は結果表示用に残す。
- 成功・最終失敗・手動停止でアクティブな `retry` は解除する。待機中に `POST /stop` を呼ぶと SDK 内部の待機が abort され、`auto_retry_end(success:false, finalError: "Retry cancelled")` → `agent_settled` の順で終わる。このとき aborted の assistant は投影に残らないため、BFF は stop 要求を控えて `run_end(status: "stopped")` にする。
- 同じランの `run_start` / `run_end` は各 1 回。待機キューはランが確定してから従来どおり進める。

### 失敗した試行の表示取り消し

- 再試行対象の失敗 assistant の途中テキストは表示から取り消し、次の試行のテキストと連結しない。確定済みのツール実行・結果と、先行する正常な assistant は消さない。生の SDK 履歴 / JSONL は改変せず、**SDK の現在のセッション投影（`session.messages`）を表示の正**とする。
- `auto_retry_start` は SDK が失敗メッセージを除外する**前**に届く。同じく `entry_appended(context_edit)` の時点でも投影はまだ古い。BFF はこのイベントの listener で同期 resync せず、microtask で 1 拍置いてから、そのランが実行中であることを確認して `resync` を 1 件配る。クライアントはこの `resync` で失敗試行のバブルを取り消し、以降の `text` を新しい試行として表示する（ライブ / SSE リプレイ / 再読み込みで同じ `messages` になる）。
- 除外が確定した時点で、BFF の保留 delta・`currentAssistantText`・応答時間の計測起点は試行単位で破棄する（保留分を flush して次の試行へ連結しない）。
- `finalize()` の最終テキスト補完と完了通知の本文は、**このランで `message_end` を観測し、かつ最終投影に残っている assistant** だけを対象にする。前のランの本文や除外された失敗試行を補完・再表示しない。
- 最終失敗（最大回数を使い切った失敗）の assistant は SDK が除外しないため投影に残る。投影の最後がこの失敗 assistant のときは、途中テキストをそのまま確定させ、別の応答を継ぎ足さない。

### 再試行状態の配信と復元

- `payload.run.retry` は `{ phase: "waiting" | "retrying", attempt, maxAttempts, retryAt?, reason }`。`reason` は分類済みコードだけで、SDK の `errorMessage` / `finalError` 原文は配らない。ライブでは同じ形を `run_retry` イベント（`totalRetryCount` と `serverNow` 付き）で配る。
- `serverNow` は payload を組み立てたサーバー基準時刻。クライアントは `retryAt - serverNow` で受信時点の残りを出し、受信後の経過分だけを引く（ブラウザ時計とサーバー時刻を直接比較しない）。予定時刻を過ぎても `message_start` が来ない場合は「再実行の開始待ち」へ切り替え、「あと 0 秒」の待機表示を残さない。
- SSE のリプレイで古い `run_retry` / `resync` が届いても、保存済みの絶対 `retryAt` を使うため待機は延長されない。

## 失敗の分類と公開契約

`server/src/error-classify.ts` の純関数が、`agent_settled` の最終エラー・`prompt()` の reject・`run_end.error`・`SessionPayload.run.error`・`resync` のすべてで共通に使う。

- 優先順位は **恒久的な利用枠 / 課金（`insufficient_quota` など）→ 認証・設定 → コンテキスト超過 → 一時的な `rate_limit`（429 / TPM / RPM）→ `unknown`**。SDK 自身の再試行可否判定を BFF で上書きはしない（分類は表示と案内のためだけに使う）。
- 公開文言はコードごとの定型日本語（理由 + 原因別の操作案内 + 再試行累計）だけとし、上流の原文・組織ID・APIキーを UI へ出さない。クレジット不足や認証失敗を「時間を置けば復旧する」と案内しない。
- `retry.reason` も同じコードだけを配る。

## 状態

セッションの状態は `SessionStore.statusOf()` が導出する。

| 状態 | 意味 |
| --- | --- |
| `idle` | ランなし |
| `running` | ラン実行中 |
| `queued` | 待機メッセージあり |
| `compacting` | 手動圧縮の実行中（SDK 実行中と保存待ちの両方） |
| `completed` | 最後のランが完了 |
| `stopped` | 最後のランがユーザー停止 |
| `error` | 最後のランがエラー |

`compacting` は queue より優先して返る（圧縮中の送信はキューに積まれるが、表示は圧縮中）。手動圧縮のライフサイクル・排他・終端の順序は [compaction.md](compaction.md#手動圧縮) を正とする。

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
- セッションの作成は最初のメッセージ送信時。未送信の新規チャットは `POST /api/sessions` を呼ばず、一覧にも出ない（エージェント切替・「新しい会話」・起動時の `/` は未選択のローカル状態だけで完結する）。起動時に会話を開くのは通知リンク `/s/<id>` が指定された場合だけで、開いた会話を `/` に畳んだ後の F5 は未選択から始まる。作成前の Model / Effort 選択は次の作成時に `POST /api/sessions` の body として送られる。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。
- エージェント定義の編集は既存チャットに遡及しない。表示用のエージェント情報は作成時に `SessionRecord` へ、実行用プロンプトは meta の `promptSnapshot` へスナップショット化し、定義の変更・削除後も `payload.agent` と復元後の実行内容は作成時のままになる。
- 会話の圧縮（compaction）は `payload.compactions` と `compaction` / `resync` イベントで配る。表示仕様と手動圧縮の契約は [compaction.md](compaction.md) を正とする。compaction entry も `session.jsonl` に保存され、復元後も区切りが再現される（`reason` / `estimatedTokensAfter` は復元後は欠ける）。
- 手動圧縮（`POST /api/sessions/:id/compact`）は run と同じく HTTP リクエストから切り離して進み、状態は `statusOf` の `compacting` として現れる。完了は同期 POST と SSE（終端 `resync` → `status`）の両方で届き、正は payload。

## 停止と破棄

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 待機キューを破棄し `queue_cleared` イベントを記録
2. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す。自動再試行の backoff 待機中なら SDK がその待機を abort する。圧縮中なら `abortCompaction()` も同時に走る）
3. 圧縮中だった場合は `compactionTask` の settle（保存と終端配信）を待つ（応答の `status` に `compacting` を残さない）
4. `finish()` が `run_end`（status: `stopped`）を記録。キューは破棄済みなので次のランは起動しない

自動再試行の待機中の中止は、SDK が失敗試行を投影から除外済みで aborted の assistant が残らない。BFF は stop の要求を `RunState` へ控え、最終 assistant の `stopReason` に依らず `stopped` とする（`run.retry` は解除し、`totalRetryCount` は残す）。

`DELETE /api/sessions/:id` は停止 + ストアの履歴削除 + 購読者への `session_deleted` 通知を行う（作業フォルダは残す）。未ロードのセッションは SDK を開かずに消せる。

## ライフサイクル / 制限

- 会話は BFF 専用ストアへ永続化し、起動時に一覧を復元する（[persistence.md](persistence.md)）。プロジェクトの登録はアプリデータの SQLite へ保存し、所属は `projectCwd` から読み取り時に解決する。
- 1 時間未使用のアイドルセッションは SWEEP でメモリから外す（実行中・キューあり・SSE 購読中は対象外）。ストアと作業フォルダは残り、次回アクセス時に SDK セッションを復元する。
- id ごとの状態（未ロード / loading / live / evicting / deleting）とライフサイクルの Promise チェーンで、ロード・sweep・削除の競合を直列化する。読み書きするファイルは `session-store` の書込みキューでも直列化する。
- サーバ終了時は進行中の書込みを flush してから全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。
