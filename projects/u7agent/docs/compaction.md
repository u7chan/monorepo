# 会話の圧縮（compaction）表示

pi SDK はコンテキストが上限に近づくと会話を自動で compaction（古いメッセージを要約へ置き換えて context から外す）する。GUI の圧縮ボタンから手動で起こすこともできる。BFF はその結果を履歴として残し、GUI は圧縮位置の区切りと要約を出す。DTO と SSE イベントの契約は [api-sessions.md](api-sessions.md)、保存を見据えた要件は [persistence.md](persistence.md) を正とする。

## SDK が起きること

- `compaction_end` の時点で、SDK は compaction entry を SessionManager に積み、`session.messages` を「最新の compaction の要約 + `firstKeptEntryId` 以降 + 圧縮後に積まれた分」へ組み替える。`getBranch()` には圧縮前の元 entry も残る（BFF は `SessionManager.inMemory`）
- `CompactionEntry` は `id` / `parentId` / `timestamp` / `summary` / `firstKeptEntryId` / `tokensBefore` / `usage` / `fromHook` を持つ。`reason` と `estimatedTokensAfter` は `compaction_end` の `CompactionResult` にしか無く、いつでも読める `session.messages` からは復元できない
- SDK は最新の compaction しか context に残さないため、2 回目以降の圧縮では以前の圧縮位置が `messages` から失われる

## 表示仕様

| 項目 | 仕様 |
| --- | --- |
| 区切り | 圧縮位置に 1 行出す。例 `ここで会話を圧縮しました（自動: 68k tokens から）`。文言は `client/src/lib/compaction.ts` の純関数が持ち、compact（portrait / landscape）でも出す |
| 理由 | `manual` = 手動 / `threshold` = 自動 / `overflow` = 上限超過。区切りと要約一覧の両方で区別する |
| 数値 | 区切りに出すのは `tokensBefore` のみ（pi TUI と同じ）。`estimatedTokensAfter` は推定値であり Context ゲージ（provider 実測）と食い違って見えるため出さない。DTO には保持する |
| 要約 | 折りたたみ（既定は畳む）。開くと全要約を古い→新しいの通し番号付きで一覧表示する |
| 位置 | 区切りを位置に出せるのは最新の 1 件だけ（`beforeMessageIndex`）。位置は `messages` と同じ集合を数えて求め、entry は「compaction より手前か」の判定にだけ使う。複数回のときは「この会話は N 回圧縮されました」を要約一覧の先頭に出す |
| 圧縮前の元メッセージ | 表示しない（entry ベースの履歴 DTO は対象外） |
| 反映 | `compaction` イベントの後に届く `resync` で `messages` / `compactions` を置き換える。SDK は送信メッセージを履歴へ入れる前に compaction を走らせることがあるため、その場合は送信メッセージが入ってから `resync` を配る（先に配るとそのメッセージが履歴から消える）。リロード・再接続はサーバー payload を正とする |
| 失敗・中断（run の自動圧縮） | `result` が無い / `aborted` / `errorMessage` ありのときは `compaction` も `resync` も配らず、履歴と区切りを変えない（既存の status 遷移とエラー表示に任せる）。手動圧縮は下の「終端の契約」で終端 `resync` を配る |

要約は `messages` に混ぜず `SessionPayload.compactions` として配り、`messages` は従来どおり role `user` / `assistant` だけにする。要約テキストは他の出力と同じマスカーを通してから配る。

## 手動圧縮

`ComposerStatus` の Context ゲージの右の圧縮ボタンから `POST /api/sessions/:id/compact` を呼ぶ。SDK の `AgentSession.compact()` は run の外（idle のとき）からしか呼べず、BFF は run 中しか SDK を subscribe していないため、手動経路の listener は `SessionStore` が `compaction_end` の間だけ持つ（`SessionStore.compact()`）。確認ダイアログは出さず、不可逆性と課金の注意は状態行の「圧縮の注意」で示す。

### 実行できるかどうかは総量では決まらない

自動と手動で条件が違う。

| | トリガ | 条件 |
| --- | --- | --- |
| 自動 | `_checkCompaction()`（ツール完了後の次ターン前 / 新プロンプト前 / overflow 回復） | `contextTokens > contextWindow − reserveTokens`（既定 16,384。厳密な不等号。128,000 のモデルで実測 111,616=false / 111,617=true）。overflow / length 回復の経路もあるので閾値だけではない |
| 手動 | `session.compact()` | 閾値は見ない。**要約対象メッセージ（または split-turn の prefix）が 1 件以上あるか**だけで決まる |

手動のカット位置は「末尾から `keepRecentTokens`（既定 20,000）を推定 tokens で溜めた地点」以上で最も近いメッセージ境界（user / assistant / bash / custom。tool result には落ちない）。その手前が要約され、境界が user メッセージでなければその turn の前半が prefix として別途要約される。

推定は `estimateTokens()` = 文字数 ÷ 4（text / thinking / tool 引数 / tool 結果。画像は 4,800 chars 固定）で、プロバイダ実測の Context ゲージとは別物。`keepRecentTokens = 20000` の実測は次のとおり（`server/test/compaction-cut.test.ts` が SDK 公開の `findCutPoint` で固定する）。

| 会話の形（推定 tokens） | 結果 |
| --- | --- |
| 20,000 ちょうど（5,000 × 4） | 不可（境界が先頭 entry に載り要約対象 0） |
| 20,001（user 1 + assistant 10,000 + user 10,000） | 可（境界が assistant に落ちて split-turn になり、先頭 1 token の prefix のみ要約。削減はほぼ無い） |
| 20,001（user 1 + user 10,000 + user 10,000） | 可（境界が user に落ち、先頭 1 token の履歴要約のみ） |
| 25,000（6,250 × 4 均等） | **不可** |
| 30,000（単一 user メッセージ） | **不可** |
| 40,000（10,000 × 4） | 可（約半分を要約） |
| 80,000（20,000 × 4） | 可（半分以上を要約） |
| 圧縮直後、追加なし | `Already compacted`。追加後も境界次第で `Nothing to compact`（実測: 2k 追加では不可、20k 追加で可） |

つまり **総量では可否を保証できない**（決定するのはメッセージ境界で、role の並びでも変わる）。「実用上 25k〜30k から安定」「削減量 ≒ 推定値 − 20k」とは言えない。Context ゲージや推定値を事前ゲートに使わない（押した結果の理由表示で足りる）。

要約そのもののコスト:

- 通常の履歴要約は **1 リクエスト**、出力上限は `min(floor(0.8 × reserveTokens), model.maxTokens)`。既定 reserve 16,384 なら **13,107**
- split-turn の prefix 要約は別リクエストで、上限は `min(floor(0.5 × reserveTokens), model.maxTokens)`。以前の履歴がある split-turn では**最大 2 リクエスト**
- 要約生成の `usage` は `CompactionInfo.usage` に既にある。**UI には出さない**（出すときはこの節に追記する）
- 推定値と実トークンの乖離: 日本語は概ね 1〜2 文字 / token なので実トークンが見積りより大きくなる。ゲージが大きく見える割に圧縮できない / 圧縮後の残りも表示上は 20k より大きくなる前提で扱う

### 進捗と終端の契約

SDK は `compaction_end` を `compact()` の解決**前**に同期で emit する（`_emit` は同期）。listener の中で `emitResync` すると、この時点で `record.compacting` はまだ true なので payload が `status: "compacting"` を再配信してしまう。また排他を先に解除すると、`persist` の await 中に `statusOf` が idle へ戻り、`postMessage` の即時 `startRun` / `updateSettings` / 二重 `compact` / `stop` が割り込んで履歴・保存スナップショット・終端 SSE の順序を壊す。`compaction` の排他は **SDK 実行中と保存待ちの両方**を覆う。

| 場面 | 順序 |
| --- | --- |
| 開始 | `resync` のみ（payload は `status: "compacting"` + `compactionStartedAt`）。client は resync の status から activity（`会話を整理中…`）と runStatus / 開始時刻を導出する（既存の running / queued / error / stopped と同じ流儀）。開始専用の `status` イベントは要らない |
| 成功 | listener は entry を控えて `compaction` を配るだけ（resync は配らない）→ `await session.compact()`（SDK はこの時点で entry を `SessionManager.inMemory` へ append 済み）→ **排他（`compacting` と `compactionStartedAt`）は保存が終わるまで保持したまま** `await persist()`（BFF が JSONL を書く）→ 直後に `record.persistError` をローカル変数へ控える → フラグを解放 → 終端 `resync`（payload の status は実効状態。`compactionStartedAt` は載せない）→ `status`（保存結果で文言を分ける。`会話を圧縮しました（N回目）` / `会話を圧縮しましたが、保存に失敗しました: <マスク済みの理由>`）→ queue があれば 1 回だけ pump |
| 失敗・中止 | listener は何も配らない（履歴が変わらないので `compaction` を配らない）→ `finally` で解放 → **終端 `resync`**（compacting の解除を別タブ・復帰に伝えるため）→ `status`（理由）。entry が append されていないので `persist` は不要 |
| 別タブ / reload / 再接続 | 初期 GET と `resync` の payload（`status` + `compactionStartedAt`）を正とする。同期 POST の応答だけに依存しない |

run の自動圧縮は「失敗・中断では `compaction` も `resync` も配らない」で、これは **run 経路の規約**。手動経路では `compaction` は配らないが、状態解除を伝えるために終端 `resync` を配る。

### ライフサイクル

- `statusOf` は compacting を queue より優先し、`isBusy` に含める。`deleteSession` / `close` / `stop` / `releaseProject` は abort の後に `record.compactionTask` の settle を await してから flush / dispose / status 返却を行う。`releaseProject` は stop の settle 後に所属変更の `resync` を配る
- `compactionTask` は最初の await より前に record へ登録し、task 内で自分自身を await する循環を作らない。完了範囲は「保存・終端 `resync` / `status`・pump の判断・排他の解放まで」
- `closing` 中は終端配信と pump を抑止するが、成功済み entry の保存は行い、task の settle と `flush` を待つ（SDK は `SessionManager.inMemory` なので、保存を飛ばすと entry が失われる）。`deleting` 中は既存の `persist` ガードで保存が no-op になり、終端配信と pump は走らない
- `stop` は `record.session.abort()`（SDK が `abortCompaction()` も呼ぶ）の後に settle を待ち、`compacting` を返さない（queue は既存どおり破棄する）。SDK が entry を append 済み（保存待ち）の段階では圧縮を巻き戻せないので、応答と表示を「中止しました」にしない（成功と保存結果を正とする）
- 圧縮中の `postMessage` はキューへ積む（`queued` を配る。上限は `MAX_QUEUE_DEPTH` と同じ）。返す `runId` に旧 run の id を含めない。`pump` は圧縮中スキップし、終端処理の後に 1 回だけ呼ぶ
- 圧縮中は `updateSettings` も二重 `compact` も 409。run 中・キュー待ち・streaming 中・設定変更中も 409（**idle のみ**）。`session.isIdle === false` も busy として扱う
- sweep は圧縮中の record を外さない

### エラー

SDK 例外は完全一致で分類する。SDK の文言はそのまま配らず、固定の文言へ置き換える。

| SDK の例外 | HTTP | `status` の文言 |
| --- | --- | --- |
| `Nothing to compact (session too small)` | 400 | まだ要約できる古い会話がありません |
| `Already compacted` | 409 | 会話はすでに圧縮されています |
| 中止（abort / `Compaction cancelled`） | 409 | 圧縮を中止しました |
| 未知の例外 | 500 | 会話の圧縮に失敗しました |

`Compaction cancelled` はユーザーの stop と extension の cancel の両方で発生し得るため、文字列だけで「ユーザーが中止した」と断定しない（文言は中止扱いに統一する）。未知の 500 は、例外の文字列を応答へ出さず、詳細は BFF のログだけに残す（文字列にはプロバイダのエラー本文が混じり得る）。

保存失敗は「要約生成の失敗」ではなく「**圧縮済みだが保存失敗**」なので:

- 同期 POST は `セッションの保存に失敗しました: <マスク済みの理由>` の 500 を返す
- 終端 `status` は `会話を圧縮しましたが、保存に失敗しました: <マスク済みの理由>` を配り、同期 POST を呼んでいない別タブにも同じ内容を伝える
- health の `dirty` にも従来どおり出る

受入条件は「保存に成功したときだけ reload 後も残る。失敗は 500 + dirty」。`setNotify` と同じく、API の成功応答を保存成功とみなさない（[session-files.md](session-files.md)）。

圧縮にはリクエストの signal を繋がない（タブを閉じても継続し、再接続の resync で揃う）。

## 環境変数（検証用）

| 変数 | 説明 |
| --- | --- |
| `PI_COMPACTION_RESERVE_TOKENS` | compaction を起こす閾値（コンテキストに残す余裕）。未設定・不正値は SDK 既定の `16384` |
| `PI_COMPACTION_KEEP_RECENT_TOKENS` | compaction 後に context へ残す直近トークン数。未設定・不正値は SDK 既定の `20000` |

## 検証

### 自動テスト（必須）

```bash
cd projects/u7agent
pnpm check   # lint → format:check → 型チェック → テスト → クライアントビルド
```

- `server/test/compaction.test.ts` — auto / 手動の両方を通す。stub の `compact()` で `compaction_start` / `compaction_end` を発火させ、payload（要約の分離・`beforeMessageIndex`・複数回・`firstKeptEntryId` が metadata entry を指す場合・マスク）と SSE イベントを固定する。手動は開始 `resync` → `compaction` → 終端 `resync` → `status` の順序、400 / 409 / 500 の分類、二重 POST・`updateSettings`・`stop` との競合、保存待ちの割り込み、削除中 / close 中の抑止、永続化と保存失敗、キューと pump を固定する。実 API は呼ばない
- `server/test/compaction-cut.test.ts` — SDK 公開の `findCutPoint` / `estimateTokens` で、上表のカット可否を固定する（実 API は呼ばない）
- `client/test/compaction.test.ts` — 区切り / 要約一覧のラベル整形を純関数として固定する（DOM は使わない）
- `client/test/chatReducer.test.ts` — `compaction` の取り込み、`resync` からの compacting / 開始時刻 / activity の導出と終端での解除、圧縮中の `queued`、run をまたぐ解除を固定する
- `client/test/composerStatus.test.ts` / `client/test/composerSettings.test.ts` / `client/test/sessionActions.test.ts` — ボタンの配置と活性条件、注意書きの導線、同期応答の操作世代ガードを固定する

### 実 API での目視（低コスト・任意）

閾値を意図的に下げれば、コンテキストを埋めずに数円以下で発火できる。入力単価が安く context の大きいモデル（例: $0.14/M input・1M context）なら、閾値 10k tokens で 1 回の発火まで 1 円未満。使うモデルは環境の利用可能モデル（`GET /api/health` の `availableModels`）に合わせる（以下の `<provider>/<id>` はプレースホルダ）。

1. `PI_CODING_AGENT_DIR=/tmp/u7agent-compact-verify` を指定し、普段の `~/.pi/agent` を汚さない。`auth.json` をコピーし、`models.json` に contextWindow の override を書く（例: `providers.<provider>.modelOverrides."<id>".contextWindow = 40000`）
2. 検証用 env で閾値を下げる（例: `PI_COMPACTION_RESERVE_TOKENS=30000` / `PI_COMPACTION_KEEP_RECENT_TOKENS=4000`）。contextWindow を触らない場合は `reserveTokens` だけで閾値を下げる。`pnpm dev` はプロジェクト root の `.env` を読むので、そこへ書くかシェルの環境変数で渡す
3. `PI_MODELS=<provider>/<id>` で起動し、長文を貼って閾値を越えさせる（10k tokens 程度）
4. 確認: 区切り位置（圧縮前のメッセージが消え、区切りと要約に置き換わる）・要約の折りたたみ・リロード後の保持・2 回目の圧縮（再度長文を貼る）・Context ゲージの推移
5. 手動経路: 会話を数往復させてから圧縮ボタンを押し、区切りが「手動」になり、押している間は状態行が `会話を整理中…` と経過時間を出すことを確認する。要約できる履歴が無いときは押した結果に「まだ要約できる古い会話がありません」が出る
6. 戻し方: 一時ディレクトリを消し、env を外すだけ（`models.json` の override も一時ディレクトリ内なので残らない）

目視の viewport は [ui-layout.md](ui-layout.md) の viewport 表（desktop 1440x900 / portrait 390x844 / landscape 844x390）に従う。確認するのは次の 3 点:

- 長い要約（1 行が長いテキスト）でも区切りと要約一覧が横に溢れない（`break-words` で折り返す）
- compact でも区切りの 1 行が出て、要約が畳まれたままである
- 状態行のゲージ + 圧縮ボタンが 390px と長いモデル名でも切れない（足りなければ組ごと 2 行目へ折り返す）
