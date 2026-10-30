# セッションの履歴と状態の API

セッションの履歴・設定・タイトル・ピン留めと、会話の移動 / 分岐の HTTP 契約。DTO の正は `server/src/schema.ts`、規約と索引は [api.md](api.md) を参照する。セッションの一覧と取得は [api-sessions.md](api-sessions.md)、送信と会話の中身は [api-session-turns.md](api-session-turns.md)、実行の観測と終了は [api-session-runtime.md](api-session-runtime.md) を参照する。

## `GET /api/sessions/:id/history`

全履歴（現行ブランチの entry 列）のカーソルページ。圧縮で context から外れた元メッセージも含む。GUI のタイムラインはこの API を正とし、`messages`（有効コンテキスト）は実行状態の同期に使う。

```
GET /api/sessions/:id/history?limit=50&before=<itemId>
```

```json
{
  "sessionId": "…",
  "items": [
    { "kind": "message", "id": "<entryId>", "context": "summarized", "role": "user", "text": "…", "at": 1700000000000 },
    { "kind": "message", "id": "<entryId>", "context": "summarized", "role": "assistant", "text": "…", "tools": [] },
    { "kind": "compaction", "id": "<entryId>", "compaction": { "id": "…", "summary": "…", "firstKeptEntryId": "…", "tokensBefore": 68000 } },
    { "kind": "message", "id": "<entryId>", "context": "active", "role": "user", "text": "…" }
  ],
  "nextCursor": "<itemId>",
  "prevCursor": "<itemId>",
  "hasMore": true,
  "activeContextStartId": "<itemId>",
  "messageCount": 120,
  "summarizedMessageCount": 84
}
```

- `items` は古い→新しい。`limit` は 1〜200 の整数（既定 50）で、範囲外は 400
- `before` はこの item より古い範囲を返す排他的カーソル。省略は最新ページ。`nextCursor` はさらに古いページを取るときの `before` に使う（それ以上は `null`）
- `prevCursor` はページ先頭 item の直前にある item の id（無ければ `null`）。クライアントはこれでページ間の連続性を判定し、保持分と繋がらない（別タブで `limit` 以上追記された / 分岐が変わった）ときは欠落区間を `before` で取り直す。取り直したページは保留していた最新ページと組み合わせて適用し、それでも繋がらないときだけ最新ページで組み直す
- 存在しないカーソルは空の成功へ縮退させず 400（`{ "error": "Unknown history cursor" }`）。存在しないセッションは 404
- assistant item の `assistantId` は BFF が保存時に写した応答IDで、ライブの delta / ツールと同じ値。旧保存データではキーを省略する
- item の `id` は SDK entry の id（id を持たない旧履歴だけ `legacy-<entry index>`）。`context` は `active`（現在も生の context にある）/ `summarized`（最新の compaction の `firstKeptEntryId` より手前）/ `excluded`（`context_edit` で外れた）で、判定は [compaction.md](compaction.md#全履歴の表示閲覧と段階読み込み) を正とする
- user item には、その発言の送信ID `sendId`（送信応答と同じ値）と、発言を注入した実行の `runId` が載る。同じ実行に複数の送信が属するため、送信の識別には `sendId` を使う。実行時の対応表（SDK メッセージ → 送信ID / 実行ID）を先に引き、再起動後は JSONL の entry に写した注記（`u7agentSendId` / `u7agentRunId`。[session-files.md](session-files.md#sendsjson-と送信id--実行id-の注記)）から復元する。クライアントはこの値で自分の送信エコーを他クライアントの同一文面 item と区別し、`run_start` やページ適用で正しい item へ吸収する。対応が無い旧保存データの item だけが、文書化済みの本文正規形（+ 送信時点の位置 `since`）での縮退対象になる（[frontend.md](frontend.md)）。未送信（下記）の item は存在しないため、同一文面の item が別 run で載っていても吸収されない
- user item のうち、実行を開始した送信にだけ `runDurationMs` / `runOutcome` が載る（追加入力へは複製しない）。値は `run_end` と同じ定義（キュー待ちと回答待ち（`ask_user` の実行区間）を含めず、`run_end.status` を終端の `completed` / `stopped` / `error` へ絞ったもの）で、そのターン最後の応答のメタ行（`Done · 1m 20s`）に使う。控えは揮発なので BFF の再起動 / アイドル sweep の後は両方とも載らず、クライアントはセグメントごと出さない（[run-lifecycle.md](run-lifecycle.md#状態)）。
- ターンの結末は、そのターン最後の本文あり応答 item にも `turnEnd`（`{ outcome, durationMs }`）として載る。値は `runDurationMs` / `runOutcome` と同じで、履歴ページの窓がターンより短く user item が読み込み範囲の外へ落ちるときのメタ行の根拠になる。どの item に載るかの正は `server/src/history-projection.ts`
- 待機した送信は受付時点では `runId` を持たず、user への注入時に実行へ割り当てる。既存の実行へ注入された送信はその `runId` を、未注入のまま終端して次の実行へ回った送信は新しい `runId` を持つ（旧実行の終了で未注入の送信を完了にしない）
- `firstKeptEntryId` は metadata entry を指し得る。その場合も「その entry 以降が有効」として位置だけを使い、メッセージ検索で境界をずらさない
- `messageCount` / `summarizedMessageCount` はページではなく現行ブランチ全体の値。クライアントは保持済みの古いページの `summarized` を更新するのに使う（この 2 つだけがページ外の全体量を表す）
- `activeContextStartId` は現在有効なコンテキストの先頭 message item。要約で置き換わった範囲が無いときは `null`
- 本文 / 要約 / ツール出力は他の経路と同じマスカーを通す（[secrets.md](secrets.md)）。JSONL の保存形式は変えない
- 投影はページ範囲を選んでからその範囲にだけ掛ける（全エントリーを DTO 化してから切らない）。表示可否（本文の有無）の判定も全文のマスクを通さず、text part の有無だけで行う

## `PATCH /api/sessions/:id/settings`

チャット単位の Model / Effort 変更。同じ SDK セッション・会話履歴・タイトルを保つ。

```json
// request (片方だけでもよい)
{ "model": { "provider": "<provider>", "id": "<id>" }, "thinkingLevel": "high" }
// response (200): セッションペイロード
```

- エージェントは変更できない（作成時の `agentId` / `promptSnapshot` が正）。別のエージェントで始めるには新しいセッションを作る。
- 省略した項目は現在値維持。空 body・`null`・不正な値・利用不能なモデルは 400、存在しないセッションは 404。
- モデルだけ変更するときは変更前の実効 Effort を退避して SDK 切替後に再適用する。両方指定したときは要求した Effort を再適用する。SDK が非対応値を補正するため、応答は補正後の実効値になる。
- 実行中・送信待ちキューあり・圧縮中・SDK が非 idle・別の設定変更中のときは 409（値は変わらない）。変更中は同セッションへの送信も 409 になり、変更完了後に解除される。
- 変更は `resync` イベントで購読中のクライアントへ同期する。

## `PATCH /api/sessions/:id/title`

会話タイトルの変更。同じ SDK セッション・会話履歴・Model / Effort を保つ。

```json
// request
{ "title": "ファイル画面の改修" }
// response (200)
{ "sessionId": "…", "title": "ファイル画面の改修" }
```

- 通知トグルと同じ専用経路で、SDK に触らず busy 判定も通さないため実行中でも変えられる。live / 未ロードのどちらでも同じ応答で、会話全文（`messages`）は返さない（未ロードでは SDK セッションを開かず `meta.json` だけを書き換える）。未知の id は 404。
- `title` は自動タイトルと同じ正規化（trim / 空白の 1 行化 / 既知の秘密値のマスク / 60 文字上限）後の値を返す。空・空白だけは 400。
- 改名した会話は、以降のメッセージから自動タイトルを作り直さない（自動タイトルは `title` が空のときだけ最初のメッセージで作る。[session-files.md](session-files.md#metajson)）。改名で由来は手動になり、進行中の AI 要約は取り消す（後から届いた結果も適用しない。抽出と AI 要約は [session-title.md](session-title.md)）。
- 保存に失敗したら 500 を返し、成功扱いにしない（in-memory の表示は新しい値のまま）。
- 一覧とチャットのヘッダは一覧 API を正とするため、クライアントは応答の `title` を手元の一覧へ反映する（他タブは一覧のポーリングで追随する。notify と同じ）。

## `POST /api/sessions/:id/title/summarize`

会話メニューからの AI 要約の再実行。保存済みのモデル / Effort / 定義で 1 回だけ生成し、現在のタイトルと
試行を返す。自動の 1 会話 1 試行とは独立で、`pending` / `failed` / `skipped` の後でも実行できる。

```json
// request: 本文なし
// response (200): 生成に失敗しても試行を返す
{
  "sessionId": "…",
  "title": "ログイン画面のエラー表示改善",
  "titleSummary": {
    "origin": "ai",
    "attempt": {
      "runId": "manual-…",
      "at": 1700000010000,
      "state": "done",
      "trigger": "manual",
      "model": "<provider>/<id>",
      "thinkingLevel": "low",
      "inputTokens": 180,
      "outputTokens": 20,
      "costTotal": 0.0002,
      "durationMs": 1200
    }
  }
}
```

- 実行中・圧縮中・別の AI 要約の実行中は 409。AI 要約が Off・モデル未選択・依頼本文なし・要約できる応答なしも 409。
- 生成に失敗した場合も 200 で `attempt.state: "failed"` と `error` を返し、`title` は変更しない。画面は
  この試行を表示して一覧を取り直す (HTTP の失敗と生成の失敗を混ぜない)。
- 手動で変更したタイトルも、この明示的な操作では置き換える (自動要約は置き換えない)。確認はクライアントが行う。
- 依頼本文は送信時にマスクした先頭 600 文字を `meta.titleRequest` に保存し、再起動後も同じ入力を使う。
  旧 meta で欠落している会話だけ最初の user メッセージから作る。応答は最後の完了した assistant テキストを使う。
- 入力の組み立て・マスク・出力検証・取消は自動要約と同じ経路を通す。予約と終端は `resync` で配る。

## `PATCH /api/sessions/:id/pin`

会話のサイドバー固定を切り替える。

```json
// request
{ "pinned": true }
// response (200)
{ "sessionId": "…", "pinned": true }
```

- live / 未ロードのどちらも同じ小さな DTO を返す。未ロードでは SDK を開かず `meta.json` だけを更新し、実行中でも切り替えられる。未知の id は 404。
- `lastUsedAt` / タイトル / 履歴は変えない。プロジェクトの登録解除後もピン状態は保持する。古い `meta.json` で `pinned` が無い場合は false。
- 保存に失敗したら 500 を返し、成功扱いにしない。クライアントは失敗時に理由を表示し、未確定の表示を戻す。
- スペース文脈は他の会話 API と同じく `?spaceId=<id>` で照合し、不一致を変更前に 404 とする。

## `POST /api/sessions/:id/move`

会話を引き継ぐ（エージェント / スペースの交代）。**会話の行・タイトル・ピン・通知・作成時刻は保ち、**会話履歴（`session.jsonl` / `sends.json`）は破棄する**（不可逆。戻すには逆方向へ引き継ぐ）。作業フォルダと添付は、同じスペースならその場のまま、別のスペースなら移動先のパスへ物理移動する。要求元のスペースは query で照合し（他の会話 API と同じ `sessionSpaceGuard`）、移動先は本文で指定する。**SDK セッションを開かない**ため、JSONL が破損していてもモデル未認証でもメモ OFF なら引き継げる。

```json
// request (?spaceId=<要求元>)
{ "spaceId": "space-…", "agentId": "…", "memo": true }
// response (200)
{ "sessionId": "…", "title": "…", "spaceId": "space-…", "memo": true, "cleanupPending": false }
```

- `agentId` は省略で現在のエージェントを維持する（現在のエージェントがカタログから消えていても引き継げる）。指定するときは**現在と同じ id でも**新規作成と同じ解決経路（スキルとツールの許可リストを含む）でスナップショットを作り直し、`agentId` / `agent` / `promptSnapshot` を揃えて差し替える（定義の更新を反映する）。未知・削除済みの id は 400。
- `memo` は省略で false（既存の「引っ越す」の意味を変えない。UI はトグルの値を常に送る）。真では、保存された会話（JSONL の entry と meta）から組み立てた節を作業フォルダ直下の `HANDOFF.md` へ先頭追記する。本文は全文を mask してから長さで切る。ライブの `messages` は使わない（再起動の前後で同じメモになる）。
- 動かせるのは `projectCwd` を持たないセッションと、`projectCwd` を持っていても**同じスペースへの引き継ぎ**だけ（別スペースは 400。作業ディレクトリが同じで移す先がない）。現在の作業フォルダが `sessionWorkdirRel(id, 現在のスペース)` と一致しない構成も 400。
- 維持: `sessionId` / `title` / `model` / `thinkingLevel` / `pinned` / `notify` / `createdAt`。差し替え: `agent` / `promptSnapshot`（`agentId` 指定時）。破棄: 履歴と未送信。`messageCount` は 0 になり、`lastUsedAt` は更新する。移動先の所属は `default` も含めて `meta.json` に明示的に書く。引き継ぎの記録（操作 ID・時刻・メモの有無・消費済み）と片付けの印も meta の任意フィールドに書く（[persistence.md](persistence.md)）。
- 実行中 / キュー中 / 圧縮中 / 設定変更中は 409（UI も同じ条件で項目を無効にする）。メモ ON で材料が無い（メッセージ 0 件、JSONL が壊れている）は 400（メモ OFF なら移せる）。片付けが残っている会話の新しい引き継ぎも 409。同じスペースへの引き継ぎは成立する。未知の id / 要求元と所属の不一致 / 未知の移動先スペースは 404。
- 作業フォルダ / 添付は移動先の親（追加スペースなら `spaces/<spaceId>/sessions` / `spaces/<spaceId>/uploads`、既定へ戻すなら `.u7agent/sessions` / `.u7agent/uploads`）を作ってから移す。移動元が無いときは「運ぶものが無い」として続行し、移動先に既存があるときはマージせず 409（退避先の削除を案内する）。再実行は冪等。
- `secrets` / `serve_commands` は cwd をキーにするため、別スペースへの引き継ぎで移動先の cwd へ 1 トランザクションで付け替える（値の AAD は cwd を含まないので再暗号化しない）。同じスペースでは何も動かさない。
- 手順は検証（副作用なし）→ メモの材料と既存の `HANDOFF.md` を読んで上限・UTF-8・バイナリを判定（最終要素の symlink もここで拒む）→（別スペースなら移動）→ メモを書く（排他の中で読み直し、同じハッシュなら追記せず、追記後の全文を上限で判定する）→ meta を書く（確定点）→ dispose・書込み drain・履歴削除 → 購読を close。**meta の書換え前に失敗したら、移したものを逆順で戻す**（新規作成したメモは、サンドボックスの排他の中で内容が一致するときだけ削除し、既存への追記は戻さない）。
- 確定後の履歴削除に失敗したときは 200 のまま `cleanupPending: true` を返す（meta には片付けの印が残る）。クライアントは移動先へ切り替えて状態行に警告を出し、次に開くときに削除から再試行する（それまで開く要求は 409）。`DELETE /api/sessions/:id` は可能で、一覧にも残る。片付けの間も `resync` で購読中のタブへ状態を配る。
- メモの冪等化: 節の先頭行に材料のハッシュを書き、書込みの排他の中で先頭行だけを見て同じハッシュなら追記しない（再試行・再起動で二重にならない。操作 ID は再試行のたびに変わるため鍵にしない）。`HANDOFF.md` の書き込み API は [sandbox-api.md](sandbox-api.md#post-v1fileshandoff) を参照。
- 引き継ぎ後の最初に受理した送信は、消費済み印の保存を**応答の前に**確かめる。進行中の保存は後続の送信 / 再送も共有して待ち、保存に失敗したときは 202 を返さず「セッションの保存に失敗しました: …」の 500 にする（未保存のまま成功を返すと、再起動でチップが戻る。[run-lifecycle.md](run-lifecycle.md#引き継ぎと復旧)）。
- 失敗の分類は移動と同じ（meta 書換え前は 400 / 409 / 500 / 502、サンドボックス未設定・永続化なし・アプリ DB 障害は 503。DB は `not_stored`）。

## `POST /api/sessions/:id/fork`

会話を分岐する。**元の会話を残したまま**、受け付けた時点の末尾までの履歴を持つ別の会話を作る。要求元のスペースは query で照合し、子のスペースは親と同じになる。

```json
// request (?spaceId=<要求元>)
{ "agentId": "…" }
// response (201): `POST /api/sessions` と同じ payload + parentSessionId
```

- 子は親の `session.jsonl` の entry をそのまま複製した別ファイルを持つ。以後の追記は独立し、自動の同期・要約・マージはしない。
- **境界は解決済みの record を受け取った直後（最初の await より前）に固定する**。送信ルートはスキル展開を await してから `postMessage` するため、同時に受付された送信は子へ入らず親にだけ残る。
- 複製の順序は「親の既存 JSONL の検証（破損は 409。ここでは親へ書かない）→ live な親の `persist` / `flush` → 境界までの読み直しと複製」。`persist` は検証をせず全体を書き直すことがあるため、検証の後にだけ置く。
- 子の store は temp ディレクトリへ書いて rename で確定する（[session-files.md](session-files.md#metajson)）。`sends.json` は作らず、未送信・通知・ピン・引き継ぎの記録は引き継がない。
- `agentId` は省略で親のスナップショット（`agentId` / `agent` / `promptSnapshot`）を維持する（カタログから消えていても分岐できる）。指定するときは引き継ぎと同じ解決経路でスナップショットを作り直し、未知・削除済みの id は 400。
- 子のモデル / Effort の初期値は親の実効値（[session-files.md](session-files.md#モデル--effort-の復元)）。以後の変更は `PATCH /api/sessions/:id/settings` で別々に行い、互いに波及しない。
- 作業フォルダと添付は親と共有する（[session-files.md](session-files.md#共有する作業フォルダと添付)）。共有フォルダが無いときは空を作らず 409 で、未ロードの親でも復元（未所属のスクラッチの mkdir）より前に検査する。
- 実行中 / キュー中 / 圧縮中 / 設定変更中 / 停止処理中 / 片付け中は 409。JSONL の破損も 409。保存に失敗したら 500。親・子の store / record / 派生データを残さずに回収する。
- `parentSessionId` は `SessionSummary` / `SessionPayload` に載る（分岐した会話だけ。親のタイトルはクライアントが同じスペースの一覧から引く）。
