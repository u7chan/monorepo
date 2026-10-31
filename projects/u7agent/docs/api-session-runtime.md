# セッションの実行と観測の API

SSE イベント、診断と生ログ、手動圧縮、停止、削除の HTTP 契約。DTO の正は `server/src/schema.ts`、イベントの意味は [run-lifecycle.md](run-lifecycle.md)、規約と索引は [api.md](api.md) を参照する。一覧と取得は [api-sessions.md](api-sessions.md) を参照する。

## `GET /api/sessions/:id/events`

SSE（`text/event-stream`）でイベントを購読。カーソルは `Last-Event-ID` ヘッダ（`<generation>:<seq>`）→ query の `generation` + `after` → `resync` の優先順位で解決する。世代（payload の `eventGeneration`）が現在と一致し、seq がバッファ範囲内のときだけ差分をリプレイし、それ以外は `resync`（セッション全体のペイロード）を 1 件送る。再起動や sweep の復元で seq が 0 に戻っても、古いタブは 1 回の resync で整合する。

接続直後と、以降 15 秒ごとに `ping`（可視イベント）を送る。`id` を付けないため `Last-Event-ID` は動かない。クライアントはこれを生存確認にだけ使い、状態には流さない（dev の Vite プロキシは upstream が落ちても接続を閉じないので、無音を切断とみなして張り直す）。

バッファからのリプレイ範囲に待機中の `run_retry` を含むときは、リプレイの末尾に現在のペイロードを持つ `resync` を 1 件続けて送る。リプレイされたイベントの `serverNow` は発行時点のままで、クライアントが受信時刻を起点にすると残り時間が過大になるため（`retryAt` は絶対値、判定は [run-lifecycle.md](run-lifecycle.md#再試行状態の配信と復元)）。

イベントタイプ:

| イベント | data |
| --- | --- |
| `run_start` | `{ runId, initialSendId?, prompt, startedAt }`（`startedAt` は payload の `run.startedAt` と同じ値。`initialSendId` は実行を開始した送信のIDで、旧サーバーは載せない） |
| `text` | `{ delta, assistantId? }`（`assistantId` はこの delta が属する応答。旧サーバーは載せない） |
| `tool_start` / `tool_end` | `{ id, assistantId?, name, args, skill?, questions?, startedAt? }` / `{ id, name, isError, output, answers?, endedAt? }`（`skill` は `run.toolCalls[].skill` と同じスキル読み込み。結果が無い時点なので `isError` は載らない。`questions` / `answers` は ask_user のときだけ載り、`run.toolCalls` と `messages[].tools` と同じ値。`startedAt` / `endedAt` は BFF 計測のツール実行の開始 / 終了で、`run.toolCalls` / `messages[].tools` と同じ値。旧サーバーは載せない） |
| `tool_progress` | `{ id, text }`（`investigate` の子の進捗。`id` は `tool_start` / `tool_end` と同じ toolCallId で、ライブの `ToolCall.progress` だけを更新する。payload には載らない live 専用） |
| `status` | `{ state, text }`（`thinking` / `writing`（本文の書き出し）/ `tool` / `question`（回答待ち）/ `compacting` / `retry` / `warning` / など。手動圧縮の終端では成功 / 失敗の文言を配る。自動再試行の文言は `run_retry` の構造化情報からクライアントが導出する） |
| `queued` | `{ position, queueDepth, sendId?, prompt }`（`sendId` は待機した送信。旧サーバーは載せない） |
| `queue_cleared` | `{ sendIds? }`（停止で回収した送信のID。クライアントは該当する送信を「未送信」へ切り替える。旧サーバーは載せない） |
| `run_retry` | `{ retry, totalRetryCount, serverNow }`（自動再試行の開始 / 再実行開始 / 解除。`retry` は payload の `run.retry` と同じ形で、解除時は `null`） |
| `run_end` | `{ runId, status, durationMs?, error, errorCode?, messageCount, queueDepth, totalRetryCount?, context? }`（同じ SDK 実行で 1 回だけ。`runId` は retry / steering で変わらない）（`messageCount` は一覧 API と同じ表示メッセージ数。`durationMs` は BFF 計測のラン全体の所要時間で、キュー待ちと回答待ち（`ask_user` の実行区間）は含めず `startRun()` から `finish()` までを測る。完了 / 停止 / エラーのいずれでも載り、クライアントは同じ値と `status` をその run の user パブルへ写してターン最後の応答のメタ行（`Done · 1m 20s`）に残す（履歴経路は `history` の `turnEnd` と `runDurationMs` / `runOutcome` が正）。状態行には活動の語（`完了`）だけを残し、時間は会話側と二重に出さない。`errorCode` は `status === "error"` のときだけ載る最終失敗の分類コードで、`error` と組になる） |
| `usage` | `{ usage?, metrics?, context?, assistantId? }`（assistant の `message_end` ごとに 1 件。usage はプロバイダが報告したときだけ、metrics は BFF 計測（復元した会話では SDK 記録値からの概算）、context は SDK の `getContextUsage()` だが履歴反映前なので確定値は `run_end` 側） |
| `assistant_end` | `{ assistantId?, model? }`（assistant の `message_end` ごとに 1 件。その応答の本文（`message_end` でのみ届く末尾を含む）と `usage` を配った後に届き、クライアントは開いている応答カードを閉じて、続く `text` を次の応答のカードへ入れる。usage / metrics は載せないが、応答の生成元モデル `model`（`provider/model`）は載せる。`null` は不明、旧サーバーはキーを省略する。未知のイベントは購読側で無視できる） |
| `compaction` | `{ compaction, count }`（`compaction_end` ごとに 1 件。`compaction` は payload の `compactions` の要素 1 つ、`count` はその時点の累計回数。run の自動圧縮では続けて同じ状態を持つ `resync` が届く（送信メッセージを履歴へ入れる前に圧縮が走った場合は、そのメッセージが入ってから届く）。手動圧縮では resync を配らず、保存の完了後に終端 `resync` が 1 回届く。`result` が無い / `aborted` / `errorMessage` ありのときは `compaction` も `resync` も配らない） |
| `resync` | セッションペイロード全体（バッファを逃した場合・世代が一致しない場合と、手動圧縮の開始 / 終端、追加入力の注入・保存確定）。失敗試行の取り消し（`context_edit`）では `resyncReason: "attempt_discarded"` を載せ、それ以外は省略する。省略は同じ実行の継続を表し、クライアントはストリーミング中の assistant を捨てない |
| `session_deleted` | `{ sessionId }`（削除時。送出後に接続を閉じる。移動は送らずに close する） |
| `ping` | `{}`（接続直後と 15 秒ごとの生存確認。`id` 無し = カーソルを動かさない） |

テキスト系イベント（`text` / `tool_start` / `tool_end` / `tool_progress` / `run_start` / `queued` / `run_end` のエラーや `resync` の `messages`・`compactions[].summary`、`compaction` の `compaction.summary` など）は、既知のプロバイダーAPIキーの値が `[REDACTED]` に置換されて配信される。対象キーと保証範囲は [secrets.md](secrets.md) を参照。

### 失敗試行の取り消しとエラーの公開契約

- 再試行対象になった失敗 assistant の途中テキストは、SDK が `context_edit` を追加して投影を更新した後に届く `resync`（`resyncReason: "attempt_discarded"`）で表示から取り消す（`resync.messages` が正）。失敗試行と次の試行のテキストは連結しない。確定済みのツール履歴・先行する正常な assistant は残る。
- `run_end.error` / `payload.run.error` / `resync` のエラーは、共通の分類（恒久的な利用枠 → 認証 → コンテキスト超過 → `rate_limit` → `unknown`）を通した定型日本語だけを配る。プロバイダーの生エラー（組織ID・APIキーを含み得る）は公開経路へ出さない。最終失敗の文言には再試行のスケジュール累計と原因別の操作案内を含める。
- `run_end.errorCode` / `payload.run.errorCode` は同じ分類コードで、`status === "error"` のときだけ載る（停止要求と例外が同時に起きたときは `stopped` を正とする）。分類コードは `run.error` の再実装ではなく、クライアントが再実行カードを出すかの判断にだけ使う。
- 分類・文言の定義と SDK イベントの対応は [run-lifecycle.md](run-lifecycle.md#自動再試行sdk-の-retry) / [run-lifecycle.md](run-lifecycle.md#失敗の分類と公開契約) を正とする。

## `GET /api/sessions/:id/diagnostics`

切り分け用のダンプ。状態の要約と、mask 済みの直近イベント（上限つき）を返す（設計と限界は [diagnostics.md](diagnostics.md)）。履歴を保存していない会話でも取れる（生ログの有無は `raw` で示す）。**本文（メッセージ / 質問 / 回答）は載せない。** イベントの `data` は mask 済みの値（`[REDACTED]`）を種別ごとの要約（プロンプトは `promptChars`、差分は `chars`、質問 / 回答は件数と `skipped`、ツール出力は `outputChars`、compaction は `summaryChars`、`resync` は件数と相関キー）へ落としてから載せる。会話タイトルは本文の先頭を含み得るため載せない。未知の id は 404。

```json
{
  "kind": "u7agent-session-diagnostics",
  "version": 1,
  "sessionId": "…",
  "capturedAt": 1700000000000,
  "eventGeneration": "a1b2c3d4",
  "lastSeq": 42,
  "status": "running",
  "meta": { "spaceId": "default", "agentId": "…", "workdir": "…", "createdAt": 0, "lastUsedAt": 0, "messageCount": 2, "notify": false, "pinned": false, "sendsDirty": false },
  "queue": { "depth": 1, "sendIds": ["…"] },
  "run": { "id": "…", "status": "running", "startedAt": 1700000000000, "totalRetryCount": 0 },
  "questions": [{ "toolCallId": "…", "questionCount": 4, "settled": false }],
  "events": { "limit": 500, "maxBytes": 524288, "available": 120, "items": [], "dropped": 0, "truncated": 0 },
  "raw": { "available": true, "bytes": 12345 }
}
```

- `meta` はエージェント / 作業ディレクトリと **直近の保存失敗**（`persistError` / `sendsError` / `sendsDirty`）だけを載せ、`promptSnapshot` などの大きい値は載せない。エージェント名とエラー文言は mask 後の値
- `queue.sendIds` / `questions` は本文を持たない（質問文と回答本文、待機メッセージの本文は入らない）
- `events.items` は古い→新しい順の直近分。`data` は emit 時に mask 済みの値を `server/src/diagnostics.ts` の `summarizeEventData` で本文なしの要約にしたもので、ツール出力は既存の要約（`server/src/session-projection.ts` の `toolResultSummary`）の文字数まで、全文は載らない。件数（`limit`）とバイト（`maxBytes`）の上限で落とした件数は `events.dropped`、`data` を切り詰めた件数は `events.truncated` に残す（`truncated` が立つイベントの `data` は元の schema を満たさないことがある）。`available` はリングバッファに残っている件数
- 未ロードの会話（再起動後など）は **SDK を復元せず**、保存済み `meta.json` の値だけを返す（`eventGeneration` は空文字、`seq` は 0、`events.available` は 0、`status` は `idle`）。復元自体が失敗する壊れた JSONL でも診断を取れるようにするため
- `run` は最後の run（終了後も `status` が残る）。実行中の自動再試行があれば `retry` を載せる
- `raw` は `session.jsonl` の有無とバイト数。`false` のときは UI がダウンロードを押せなくする

## `GET /api/sessions/:id/raw`

`session.jsonl`（pi SDK 形式。**mask 前**の値を含む）を `Content-Disposition: attachment` で返す。1 操作 1 ファイルで、保存名は `u7agent-raw-<id8>-<yyyymmdd-hhmm>.jsonl`。サイズ上限は既存のセッションファイルの扱いと同じく設けず（ストリームで返す）、`Cache-Control: no-store` と `nosniff` を付ける。未ロードの会話でも **SDK を復元せずに**返す（壊れた JSONL を取るための経路なので、読み込みで失敗させない）。

- 未知の id と、履歴を保存していない / 破棄済みの会話は 404（`この会話の記録は保存されていないため、生ログは取れません。`）
- 開示の確認は UI が取る（毎回の確認ダイアログ + 常設の注意書き）。`meta.json` / `sends.json` は同梱しない

## `POST /api/sessions/:id/compact`

手動でのコンテキスト圧縮（compaction）。body は無し。**完了まで待って**実効状態を返す（途中経過と結果は SSE が配る）。進行中のタブを閉じても圧縮は続く（リクエストの signal は繋がない）。

```json
// response (200)
{ "sessionId": "…", "status": "idle" }
```

- 呼べるのは **idle のときだけ**。実行中・キュー待ち・streaming 中・設定変更中・既に圧縮中なら 409
- SDK の例外は完全一致で分類し、`Nothing to compact (session too small)` は 400、`Already compacted` は 409、中止（abort / `Compaction cancelled`）は 409、未知の例外はマスクした文言で 500。501 はランタイムが `compact()` を持たないとき
- **保存失敗は 500**（`セッションの保存に失敗しました: …`）。それでも圧縮自体は成立しているため、`compaction` と終端 `resync` は配られ、履歴は巻き戻らない。health の `dirty` に出る
- 同期応答は状態の正ではない（別タブ / reload / 再接続は payload と `resync` を正とする）。進捗と終端の契約・文言は [compaction.md](compaction.md#手動圧縮)
- 404 は未知のセッション。未対応のランタイムは 501

## `POST /api/sessions/:id/stop`

実行中のランを中断し、待機キューを破棄する。`{ ok: true, status: "stopped" }` を返す。旧 `POST /api/sessions/:id/abort` も同じ動作のエイリアス。

圧縮中に呼んだ場合は SDK の `abortCompaction()` も走り（`abort()` が内部で呼ぶ）、BFF は圧縮の task（保存と終端配信）の settle を待ってから応答するため、応答の `status` が `compacting` になることはない。SDK が entry を append 済み（保存待ち）の段階では圧縮を巻き戻せないので、表示と応答は圧縮の成功と保存結果を正とする。

## `DELETE /api/sessions/:id`

セッションを削除する。停止 + 会話ストアの履歴削除を行い、購読中の SSE には `session_deleted` が通知される。作業ディレクトリ（プロジェクト所属は登録ディレクトリ、未所属は所属スペースのスクラッチ）と添付は残る（置き場は [session-files.md](session-files.md#スペースごとの配置)）。未ロードのセッションは SDK セッションを開かずに消せる（モデル未認証・JSONL 破損でも削除できる）。未知の id は 404。
