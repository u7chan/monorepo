# ランのライフサイクルとセッション状態

エージェントの実行（ラン）は HTTP リクエストから完全に切り離され、`server/src/sessions.ts` の `SessionStore` が所有する。イベント変換は `server/src/run-events.ts`、DTO 組み立ては `server/src/session-projection.ts` / `session-payload.ts` / `compaction-view.ts` に分かれる。実行・イベント・停止の原則は [architecture.md](architecture.md#基本原則) を参照する。

## ランのライフサイクル

送信は受付ごとに `sendId`、一続きの SDK 実行は `runId` で識別する。`sendId` は同じ本文でも別に振り、未送信の手動再送では変えない。`runId` は開始送信と、その実行へ注入された追加入力が共有する。

```
POST /api/sessions/:id/messages { text }
  ├─ アイドル → SessionStore.startRun() → 202 { queued: false, sendId, runId }
  └─ 実行中   → BFF の配送キューへ積む   → 202 { queued: true, sendId, queueDepth }
                    （キューは最大 10 件。SDK へ渡した分も含めて数える。超過は 429）

startRun():
  1. run オブジェクト生成（runId / initialSendId / status: "running"）
  2. run_start イベントを記録
  3. session.subscribe() で pi のイベントを変換して記録（変換は `server/src/run-events.ts`）
     - message_update / text_delta → text / status（本文の書き出しに入った最初の delta だけ）
     - message_end(user)          → 注入の観測。sendId / runId を対応付け、保存を待たず resync
     - tool_execution_start/end    → tool_start / tool_end
     - tool_execution_update       → tool_progress（investigate の進捗だけ。live 専用）
     - auto_retry_start/end        → run_retry / status（後述）
     - entry_appended(context_edit) → 失敗試行の取り消し resync（後述）
     - agent_settled               → 終了判定
  4. session.prompt(text) を fire-and-forget で呼ぶ（await しない）
  5. 開始送信の user 注入を観測したら、その時点で受付済みの待機を session.steer() へまとめて渡す
     （SDK が次のモデル判断の前に全件注入する）
  6. agent_settled（または prompt の解決）で finish():
     - 失敗試行の取り消し後の最終テキスト補完（対象はこのランで観測した assistant だけ）
     - SDK に未注入のまま残った steering の回収（実キューに残っていれば BFF の配送へ戻し、
       取り出し済みの分は未送信に残す）
     - run.status を completed / stopped / error に確定
     - run_end イベントを記録
     - キューがあれば 200ms 後に pump() で次の送信を開始送信として実行
```

SDK の `agent_settled` は、BFF が持つ追加入力の注入完了を意味しない。BFF は `record.run.status` と SDK の `isStreaming` / `isIdle` を併せて配送フェーズを判断し、`isStreaming` 単独では決めない。

## 追加入力（steering）の配送

`server/src/sessions.ts` の `SessionStore` が、`sendId` 付きの FIFO を未配信入力の正として持つ。実行中に受付した待機は、SDK の steering キューへ受付順でまとめて渡し、SDK が次のモデル判断の前に全件注入する。1 件ずつ渡すと注入のたびに次のモデル判断が走り、入力のたびに軌道修正が繰り返されるため、BFF は先頭が注入されるのを待たない。状態の一覧は `server/src/schema.ts` の `PendingSendSchema`、配送状態の導出は `server/src/session-steering.ts` と `server/src/session-payload.ts` の `pendingSendsOf()` を正とする。

- 最初の user の注入を観測するまで追加入力は SDK へ渡さない（開始準備中の取り違えを防ぐ）。注入を観測したら、その時点で受付済みの待機をまとめて渡す。注入中に届いた待機は改めて次の判断へ渡す。
- `steer()` は拡張の入力ハンドラを await してから実キューへ積むため、BFF は受付を 1 本の直列チェーンに載せる。各段の直前に実行の同一性と待機の残存を確認し、取消・停止・終端で渡せなくなった分は配送から外して BFF の待機へ戻す。
- SDK の実キューに未注入で残るかは `session.agent.peekQueuedMessages()` で見る。実キューにある間は BFF の一覧でも `queued`（取消できる）、SDK が取り出した後は `steering`（反映中、取消・再送・破棄は不可）として配る。取り出し済みかは保存せず、`handedOff` かつ `steered` の件数から実キューの件数を引いた先頭分として導出する（実キューには受付順の末尾側が残る）。
- 実行が終端したとき、実キューに残っていれば `clearQueue()` して BFF の配送へ戻し、次の実行の開始送信にする。SDK が取り出して user を注入しなかった場合は配送対象から外し、未送信として残す（自動で再投入しない）。取り出し済みかは `clearQueue()` の前に実キュー件数から確定する。
- アイドルの SDK へ `steer()` だけを残さない。BFF の終端処理中や手動圧縮中は待機だけを保持し、終端後に先頭から次の実行を開始する。
- `session.steeringMode` が `"all"` でない SDK（旧 SDK）は、実キューが先頭 1 件しか見えず一括ドレインの前提が成り立たないため、一括配送をせず 1 件ずつ渡す。

## 自動再試行（SDK の retry）

モデルの一時的なレート制限などは、pi SDK の agent-level リトライ（`SettingsManager` の `retry: { enabled: true, maxRetries: 2 }`）に任せる。**BFF は `prompt()` を再発行しない**（ユーザーメッセージやツール実行を二重に走らせない）。backoff は SDK の指数バックオフで、既定は 2 秒 → 4 秒。プロバイダーの `Retry-After` ヘッダーや本文の「Please try again in Xs」は SDK では使われないため、待機時間を上流の指定として保証しない。

SDK 1.4.0 で観測する順序（スタブではなく SDK 実体の回帰テストで固定）:

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
- 同じ SDK 実行の `run_start` / `run_end` は各 1 回。retry と steering では `runId` を変えず、所要時間もリセットしない。追加入力は新しいランを始めない。

### 失敗した試行の表示取り消し

- 再試行対象の失敗 assistant の途中テキストは表示から取り消し、次の試行のテキストと連結しない。確定済みのツール実行・結果と、先行する正常な assistant は消さない。生の SDK 履歴 / JSONL は改変せず、**SDK の現在のセッション投影（`session.messages`）を表示の正**とする。取り消すのは未確定の assistant バブルだけで、実行中ツールのカードはクライアントが run 側の状態（`payload.run.toolCalls` / `ChatState.runTools`）から現在ターンの assistant バブルへ補う（[frontend.md](frontend.md#チャット状態とレンダリング)）。
- `auto_retry_start` は SDK が失敗メッセージを除外する**前**に届く。同じく `entry_appended(context_edit)` の時点でも投影はまだ古い。BFF はこのイベントの listener で同期 resync せず、microtask で 1 拍置いてから、そのランが実行中であることを確認して `resync` を 1 件配る。クライアントはこの `resync` で失敗試行のバブルを取り消し、以降の `text` を新しい試行として表示する（ライブ / SSE リプレイ / 再読み込みで同じ `messages` になる）。
- 除外が確定した時点で、BFF の保留 delta・`currentAssistantText`・応答時間の計測起点は試行単位で破棄する（保留分を flush して次の試行へ連結しない）。
- `finalize()` の最終テキスト補完と完了通知の本文は、**このランで `message_end` を観測し、かつ最終投影に残っている assistant** だけを対象にする。前のランの本文や除外された失敗試行を補完・再表示しない。
- 最終失敗（最大回数を使い切った失敗）の assistant は SDK が除外しないため投影に残る。投影の最後がこの失敗 assistant のときは、途中テキストをそのまま確定させ、別の応答を継ぎ足さない。

### 再試行状態の配信と復元

- `payload.run.retry` は `{ phase: "waiting" | "retrying", attempt, maxAttempts, retryAt?, reason }`。`reason` は分類済みコードだけで、SDK の `errorMessage` / `finalError` 原文は配らない。ライブでは同じ形を `run_retry` イベント（`totalRetryCount` と `serverNow` 付き）で配る。
- `serverNow` は payload を組み立てたサーバー基準時刻。クライアントは `retryAt - serverNow` で受信時点の残りを出し、受信後の経過分だけを引く（ブラウザ時計とサーバー時刻を直接比較しない）。予定時刻を過ぎても `message_start` が来ない場合は「再実行の開始待ち」へ切り替え、「あと 0 秒」の待機表示を残さない。
- SSE のリプレイで古い `run_retry` / `resync` が届いても、保存済みの絶対 `retryAt` を使うため待機は延長されない。サーバーはリプレイ範囲に待機中の `run_retry` を含むとき、古い `serverNow` のままで残り時間を計算させないよう、リプレイの末尾へ現在のペイロードを持つ `resync` を 1 件追加する。クライアントも同じ試行（同じ `attempt` / `retryAt`）の再受信では、既に得た期限より後ろへ待機を延ばさない。

## 失敗の分類と公開契約

`server/src/error-classify.ts` の純関数が、`agent_settled` の最終エラー・`prompt()` の reject・`run_end.error`・`SessionPayload.run.error`・`resync` のすべてで共通に使う。

- 優先順位は **恒久的な利用枠 / 課金（`insufficient_quota` など）→ 認証・設定（`auth_required`。保存済み OAuth の失効・更新失敗は `oauth_expired` で、再サインインだけが復旧手段）→ モデルの可用性（`model_unavailable`。契約・アカウント種別で許可されていないモデル）→ コンテキスト超過 → 一時的な `rate_limit`（429 / TPM / RPM）→ `unknown`**。SDK 自身の再試行可否判定を BFF で上書きはしない（分類は表示と案内のためだけに使う）。`model_unavailable` は選び直しだけが復旧手段なので、時間をおけば直ると案内しない（設定 → モデル の保存は live の会話モデルを変えないため、案内は入力欄の上のモデル名からの選び直しを指す）。`oauth_expired` はAPIキーの登録やサーバーの再起動では直らないため、既存の `auth_required` とは文言を分ける。再サインインの案内は、設定 → モデル → プロバイダー にサインインの操作がある provider はそこを、無い provider（[model-settings.md](model-settings.md#oauth-サインイン) の許可リストに無い provider）は同じ agent dir を使う `pi /login` を指す。
- 公開文言はコードごとの定型日本語（理由 + 原因別の操作案内 + 再試行累計）だけとし、上流の原文・組織ID・APIキーを UI へ出さない。クレジット不足や認証失敗を「時間を置けば復旧する」と案内しない。
- `retry.reason` も同じコードだけを配る。
- 最終失敗の分類コードは `RunState.errorCode` に控え、`run_end.errorCode` と `payload.run.errorCode` として公開する。載せるのは `run.status === "error"` のときだけとし、停止要求（`stopRequested`）と listener 例外 / `prompt()` reject が同時に起きたときは `stopped` のままコードを載せない（停止直後に再実行カードを出さない）。成功・停止・実行中の `run` はキーを持たない（payload 上は後方互換のため optional）。
- クライアントは分類コードが `rate_limit` / `unknown` のときだけ、`run.error` の 1 文をそのまま使った再実行カードを出す。押すと固定文言「前回の続きから再開してください」を通常の `POST /api/sessions/:id/messages` へ送るだけで、添付は載せず（編集中のチップも消費しない）、BFF から `prompt()` は再発行しない（[frontend.md](frontend.md#チャット状態とレンダリング)）。

## 状態

セッションの状態は `SessionStore.statusOf()` が導出する。

| 状態 | 意味 |
| --- | --- |
| `idle` | ランなし |
| `running` | ラン実行中 |
| `queued` | 未配信の追加入力あり（`running` が無い短い過渡。通常は次のランが始まるまでで、手動圧縮の終端でも配られる） |
| `compacting` | 手動圧縮の実行中（SDK 実行中と保存待ちの両方） |
| `completed` | 最後のランが完了 |
| `stopped` | 最後のランがユーザー停止 |
| `error` | 最後のランがエラー |

`statusOf()` は compacting → running → queued → 終端 の順に見るため、実行中に送ったメッセージでは `queued` にならない（追加入力は `running` のまま配信される）。`compacting` は queue より優先して返る（圧縮中の送信はキュ��に積まれるが、表示は圧縮中）。手動圧縮のライフサイクル・排他・終端の順序は [compaction.md](compaction.md#手動圧縮) を正とする。終端（`completed` / `stopped` / `error`）は一覧 API には出るが、左バーは live のみを出す（表示規則は [ui-layout.md](ui-layout.md#nav-モード) を正とする）。

`finish()` はラン終了時に、キュー待ちと回答待ち（`ask_user` の実行区間）を含まない SDK 実行全体の所要時間（`startRun()` から `finish()` まで）と終端の 3 値（`completed` / `stopped` / `error`）を run id ごとに `SessionRecord` へ控える。回答待ちの区間の規則は [ask-user.md](ask-user.md#回答待ちと所要時間) を正とする。所要時間と結末は **開始送信の item にだけ**載せ、追加入力へ複製しない。ターンの結末（`turnEnd`）は、その実行の最後の本文あり応答 item にだけ載せる（本文なしの終端では応答を捏造せず、既存の状態表示を使う）。ライブは `run_end` の `durationMs` と `status` を開始送信のパブルへ写す（履歴経路の値を正とする）。控えはメモリのみ（`toolTimings` / `compactionMeta` と同じセッション寿命）で、再起動とアイドル sweep の後は載らず、表示側はセグメントごと出さない。

## イベントログと SSE

- ログは `{ seq, type, data, at }` の配列。セッションごとに直近 2000 件を保持。
- `GET /api/sessions/:id/events` が SSE 購読エンドポイント。イベント種別と data の契約は [api-session-runtime.md](api-session-runtime.md) を参照。
  - SSE の `id` は `<generation>:<seq>`。`generation` は record のロードごとに発行する 8 hex で、再起動や sweep 後の復元で変わる。seq は復元で 0 に戻るため、数値カーソルだけでは古いタブの位置を判別できない。
  - カーソルの優先順位は `Last-Event-ID` ヘッダ → query の `generation` + `after` → `resync`。generation が一致し、seq がバッファ範囲内のときだけ差分をリプレイし、それ以外はセッション全体のペイロードを持つ `resync` を 1 件送る。
- 接続の生存確認は可視イベントの `ping`（接続直後と 15 秒ごと、`id` 無し = カーソルを動かさない）で行う。購読は複数タブから可能で、切断してもランには影響しない。
- SSE で配るテキストは、マスク済みの値だけを載せる（[secrets.md](secrets.md)）。

## 会話履歴

- 履歴の正は pi セッションの `messages` で、その永続化は BFF 専用ストアの `session.jsonl`（pi SDK 形式）が持つ（[persistence.md](persistence.md) / [session-files.md](session-files.md)）。`GET /api/sessions/:id` が user / assistant のテキストに整形して返す。
- BFF は起動時にストアを走査して一覧（meta ベースの descriptor）を作り、セッションを開いたとき（GET / POST messages / SSE）に SDK セッションを遅延生成する。未ロードのセッションは SDK を必要としない。
- タイトルは最初のユーザーメッセージ（60 文字）から自動生成し、meta へ保存する。セッション一覧 `GET /api/sessions` は状態・件数・最終使用時刻付きで返す。
- セッションの作成は最初のメッセージ送信時（添付のアップロードでも作られる）。未送信の新規チャットは `POST /api/sessions` を呼ばず、一覧にも出ない（「新しい会話」・会話を指定しない `/` の起動・未作成チャットでのエージェント選択はローカルの状態だけで完結する）。起動時に会話を開くのは URL が `/s/<id>` を指定する場合だけで、開いた会話は URL に残るため F5 でも同じ会話に戻る（[frontend.md](frontend.md#会話-url)）。作成前の Model / Effort 選択は次の作成時に `POST /api/sessions` の body として送られる。
- ラン中に再接続したクライアント向けに、`payload.run.toolCalls` で進行中ランのツールカード状態も返す。
- 202 で受理した送信は user entry が保存されるまで未送信（`sends.json`）として控え、再起動や停止で実行されなかった分は payload の `pendingSends`（`state: "unsent"`）で「未送信」として見せる（履歴の同一文面 item へ黙って吸収させない）。`run_end` で user entry を残さずに終わった run（認証エラー等）も、保存の後に `resync` を 1 件配って未送信として見せる。契約は [api-session-turns.md](api-session-turns.md#post-apisessionsidmessages) / [frontend.md](frontend.md#チャット状態とレンダリング)。
- エージェント定義の編集は既存チャットに遡及しない。表示用のエージェント情報は作成時に `SessionRecord` へ、実行用プロンプトは meta の `promptSnapshot` へスナップショット化し、定義の変更・削除後も `payload.agent` と復元後の実行内容は作成時のままになる。
- 会話の圧縮（compaction）は `payload.compactions` と `compaction` / `resync` イベントで配る。表示仕様と手動圧縮の契約は [compaction.md](compaction.md) を正とする。compaction entry も `session.jsonl` に保存され、復元後も区切りが再現される（`reason` / `estimatedTokensAfter` は復元後は欠ける）。
- 手動圧縮（`POST /api/sessions/:id/compact`）は run と同じく HTTP リクエストから切り離して進み、状態は `statusOf` の `compacting` として現れる。完了は同期 POST と SSE（終端 `resync` → `status`）の両方で届き、正は payload。

## 停止と破棄

`POST /api/sessions/:id/stop`（旧 `/abort` もエイリアスとして有効）:

1. 新規の送信を 409 にし、配送キューと SDK の実キューを回収して `queue_cleared` イベントを記録（回収した送信の `sendIds` を載せ、クライアントは該当する送信を「未送信」へ切り替える。記録は `sends.json` に残るため、再送か破棄まで未送信として読める）
2. 未 settle の `ask_user` の待機を取り消す（[ask-user.md](ask-user.md#待機のライフサイクル)。ツールは `isError: true` の結果を返し、カードは「回答なしで終了」として残る）
3. `session.abort()` を呼ぶ（pi が `agent_settled` / stopReason `aborted` を返す。自動再試行の backoff 待機中なら SDK がその待機を abort する。圧縮中なら `abortCompaction()` も同時に走る）
4. 圧縮中だった場合は `compactionTask` の settle（保存と終端配信）を待つ（応答の `status` に `compacting` を残さない）
5. `finish()` が `run_end`（status: `stopped`）を記録。停止後は自動配送せず、回収した入力は手動の再送 / 破棄に任せる

停止で中断したツールは、SDK が中止の `toolResult` を残すため、本文を持たない応答の item（ツールカード付き）として履歴に残る。同じ会話で次の run を完了させた後や再読み込みでも消えない（[api-sessions.md](api-sessions.md#get-apisessionsid)）。

自動再試行の待機中の中止は、SDK が失敗試行を投影から除外済みで aborted の assistant が残らない。BFF は stop の要求を `RunState` へ控え、最終 assistant の `stopReason` に依らず `stopped` とする（`run.retry` は解除し、`totalRetryCount` は残す）。

`DELETE /api/sessions/:id/queue/:sendId` は待機から 1 件だけ外して未送信として残す。実行中のターンは止めず、残った待機の順位は繰り上がる。BFF が保持する分はそのまま外し、SDK へ渡した分は `clearQueue()` の前に実キュー件数から取り出し済みかを確定し、取り出し済みなら 409、実キューに残っていれば `clearQueue()` して残りを渡し直す。キュー全体の破棄は `POST /stop`、記録ごと消すのは `DELETE /api/sessions/:id/unsent/:sendId`。

`DELETE /api/sessions/:id` は停止 + ストアの履歴削除 + 購読者への `session_deleted` 通知を行う（作業フォルダは残す）。未ロードのセッションは SDK を開かずに消せる。

## 引き継ぎと復旧

会話を引き継ぐ（エージェント / スペースの交代）ときの状態と失敗時の復旧。API の契約は [api-session-state.md](api-session-state.md#post-apisessionsidmove)、メモの書き込みは [sandbox-api-files.md](sandbox-api-files.md#get-v1fileshandoff) を正とする。

可逆でない操作をまたぐため、**meta の書換えを確定点**にし、それより前の失敗はmeta とファイルを元のままにする。

1. 検証（副作用なし。スクラッチ・busy・片付け・エージェント・プロジェクト × 別スペース・メモの材料）
2. メモの下準備: 保存された会話から節を組み立て、既存の `HANDOFF.md` を読んで上限（2 MiB）/ UTF-8 / バイナリを判定する（ここまでの失敗は何も変えない）
3.（別スペースなら）作業フォルダ / 添付の移動と cwd キーの付け替え
4. メモの先頭追記（トグル ON のとき。サンドボックス側で読む→先頭に付ける→temp + rename）
5. **meta の書換え（確定点）**: 新しいエージェントのスナップショット、`messageCount: 0`、引き継ぎの記録、`handoffCleanup: true`
6. dispose・書込み drain・履歴の削除・`handoffCleanup` の解除
7. 購読を close して応答

- **3〜5 の失敗（確定前）**: 移したものを逆順で戻してエラーを返す。会話は元のままで、チップも出ない。新規作成したメモは自分が書いた内容と一致するときだけ削除し、**既存への追記は戻さない**（他の追記や編集を巻き戻さないため。下準備のあとに別の会話の追記が入っていれば、照合と削除をサンドボックスの同じ実パス排他の中で行うので消えない）。
- **6 の履歴削除に失敗（確定後）**: 成功の応答を返し `cleanupPending` を載せる（meta の `handoffCleanup` は真のまま）。クライアントは移動先へ切り替えて状態行に警告を出す（スペース切替をまたぐため、結果を `SpacesApp` が持ち、移動先の `App` が入口の解決後に出す）。以降の「開く」要求は片付けを試してから SDK セッションを作り、削除に失敗し続ける間は 409 で拒む（一覧には残り、`DELETE` はできる）。新しい引き継ぎも先に片付けを求める。
- **6 の `handoffCleanup` 解除に失敗**: 確定は済んでいるため印が残るだけ。次の保存で再試行する。
- 成功・失敗にかかわらず、引き継ぎ後の**最初に受理した送信**で meta の消費済みを立て、**受理応答を返す前に保存の成功を確かめる**（未送信の破棄・応答直後の再起動でも戻らない）。進行中の保存は別タブの送信や再送も共有して待ち、失敗したときは 202 を返さず 500 にする（失敗した印は次の受理でやり直す）。チップ「HANDOFF.mdを参照」は `meta.handoff` の `memo && !consumed` から導出する（[ui-layout.md](ui-layout.md#スペース)）。

**確定より前にメモを書く**ので、確定した時点でメモの状態は最終（書けているか、意図的に無しか）になる。確定とメモの間でプロセスが落ちても「メモが無い」だけで矛盾しない。冪等化は節の先頭行の材料ハッシュで、再試行・再起動でも二重にならない（操作 ID は再試行のたびに変わるため鍵にしない）。

既知の窓: 別スペースの引き継ぎでフォルダ移動の後・meta の確定の前に落ちると、meta は移動元のまま、ファイルと cwd キーだけが移動先に残る（既存の引っ越しにも同じ窓がある）。引き継ぎは成立せず、会話は移動元のスペースで開いて作業フォルダは空になる。**もう一度引き継ぎ（または引っ越し）を実行すれば成立する**（移動は「移動元なし・移動先あり」を移動済みとして続行する冪等な契約）。同じスペースへの引き継ぎではフォルダが動かないためこの窓は無く、残り得るのはメモだけ。**メモを確定より前に書いて meta の保存だけが失敗した場合は、再試行の材料が同じなら先頭の材料ハッシュが一致するので追記されない**（追記後の全文がちょうど 2 MiB でも、事前判定は追記不要として読む）。**エージェントの `bash` と引き継ぎの書込みは排他できない**（原子的な置換で部分的なファイルは残さないが、同時編集は後勝ちになり得る）。

## 分岐

会話を分岐する（`POST /api/sessions/:id/fork`）ときの状態。API の契約は [api-session-state.md](api-session-state.md#post-apisessionsidfork) を正とする。

- **境界は解決済みの record を `SessionStore.fork()` が受け取った直後（最初の await より前）**に、末尾 entry の id として固定する。送信ルートはスキル展開を await してから `postMessage` するため、lifecycle を押さえるだけでは「同時に受付された送信」を境界から除外できない。
- busy（実行中 / キュー待ち / 圧縮中 / 停止処理中 / 設定変更中）と片付け中は 409。分岐は保存済みの末尾までのスナップショットに限り、実行中の会話は分岐しない。
- 親の live な record は `persist` + `flush` してから境界までを読み直して複製する。**破損の検証は必ず `persist` より前**に行い、破損時は親の meta / JSONL を書き換えない。
- 子の SDK セッションは複製した entry から組み立てる。子の load に失敗したとき・load 中に DELETE されたとき・rename に失敗したときは、SDK セッション・record / descriptor・子ディレクトリ・複製した実測を回収する（半端な子は一覧に出さない）。回収は親の状態を変えない。
- 進行中の分岐は、同じスペースの削除が待つ（子は親と同じスペースに入るため）。待った後は親の存在と所属スペースを再確認する。
- 子のタイトル試行は親から複製し、`pending` は子だけ `interrupted` に終端化する（子の最初の完了で要約し直さない。親の meta / `titleTask` は変えない）。親に試行が無ければ子も未試行で、子の最初の正常完了で 1 回だけ要約され得る（[session-title.md](session-title.md#実行のタイミングと試行)）。

## ライフサイクル / 制限

- 会話は BFF 専用ストアへ永続化し、起動時に一覧を復元する（[persistence.md](persistence.md)）。プロジェクトの登録はアプリデータの SQLite へ保存し、所属は `projectCwd` から読み取り時に解決する。
- 1 時間未使用のアイドルセッションは SWEEP でメモリから外す（実行中・キューあり・SSE 購読中は対象外）。ストアと作業フォルダは残り、次回アクセス時に SDK セッションを復元する。
- `ask_user` の回答待ちはタイムアウトを持たず、`sweep` の対象外（busy）でもある。放置するとランは `running` のまま残り、他クライアントの送信は BFF の配送キュー（最大 10 件、超過は 429）に溜まり、Discord の完了通知も来ない。回答待ちの間に受理した入力は同じ実行への steering として扱い、回答と同じバッチの全ツール完了後に注入する（回答・取消にはしない）。逃げ道は停止だけで、停止は未配信の入力を未送信へ回収する（待機中の分は 1 件ずつ `DELETE /api/sessions/:id/queue/:sendId` で取り消せる。運用影響は [ask-user.md](ask-user.md#運用影響と既知の制限)）。
- id ごとの状態（未ロード / loading / live / evicting / deleting）とライフサイクルの Promise チェーンで、ロード・sweep・削除の競合を直列化する。読み書きするファイルは `session-store` の書込みキューでも直列化する。
- サーバ終了時は進行中の書込みを flush してから全セッションを abort + dispose する。
- テスト（`server/test/`）は pi をスタブし、`createBffApp({ pi })` に注入して検証する。HTTP 層は `app.request()` で叩き（listen なし）、store 挙動は直接検証する。実 API は呼ばない。
