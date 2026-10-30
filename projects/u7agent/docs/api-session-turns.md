# セッションの送信と会話の API

メッセージの送信（追加入力・添付・`/skill:` の展開）と、エージェントからの質問、セッションで使えるスキル、セッションへのファイル追加の HTTP 契約。DTO の正は `server/src/schema.ts`、規約と索引は [api.md](api.md) を参照する。一覧と取得は [api-sessions.md](api-sessions.md)、履歴と状態は [api-session-state.md](api-session-state.md) を参照する。

## `POST /api/sessions/:id/messages`

メッセージ送信。**202 で即時返却**し、ランは裏で続く。実行中に呼ぶとキューに積まれる（最大 10 件、超過は 429）。

```json
// request
{ "text": "README を読んで改善案を 3 つ" }
// request (定型プロンプトを結合した送信。titleSource は結合前の本文)
{ "text": "固定の前置き\n\nREADME を読んで改善案を 3 つ", "titleSource": "README を読んで改善案を 3 つ" }
// request (添付あり)
{ "text": "これを見て", "attachments": [".u7agent/uploads/a1b2c3d4e5/photo-1.png", ".u7agent/uploads/a1b2c3d4e5/report.pdf"] }
// request (未送信メッセージの再送。text は載せない)
{ "resendSendId": "…" }
// response (202)
{ "sessionId": "…", "status": "running", "queued": false, "queueDepth": 0, "sendId": "…", "runId": "…" }
```

- `attachments` は root 相対のパスで、そのセッションの保存先（[session-files.md](session-files.md#スペースごとの配置)）配下だけを許可する（`./` は正規化、`..`・絶対パス・ディレクトリ自体・別セッションの保存先は 400）。最大 10 件、文字列以外は 400。
- `text` は空でも添付があれば送れる（本文も添付も無いときだけ 400）。
- `resendSendId` は payload の `pendingSends` の `sendId` を指定する。本文はストアに保存済みの生テキストを使い、同じ送信IDで実行し直す（表示用のマスク済み本文を送り直さない）。実行へ割り当て直すときは新しい `runId` になる。互換名 `resendRunId` も送信IDとして受け付け、両方の同時指定は 400。配送中 / 実行中 / 注入済みの送信IDへの二重の再送は重ねず、現在の状態を返す。記録が無い（保存済み / 破棄済み）送信IDは 409。受理の記録はそのままで、user entry が保存された時点で未送信から外れる。受付後は `resync` を 1 件配り、別タブの未送信表示を更新する（キュー受付の `queued` は `sendId` を載せる）
- `titleSource` は一覧タイトルの元にする本文で、定型プロンプト（チップ）を結合する前の入力を渡す。省略時は `text` を使う（従来形式のクライアントはタイトル用の情報を送らない）。`text` と同じ上限（413）を適用し、`text` を超える情報は受け付けない。タイトルの抽出規則と AI 要約は [session-title.md](session-title.md)
- `text` が `/skill:` で始まるときは、BFF が本文ブロックへ展開してから送る（[`/skill:` の展開](#skill-の展開)）。タイトルは展開前の `titleSource` から、認識したスキル参照だけを外して作る（`<skill …>` の本文をタイトルへ混ぜない）。`/skill:` を参照として外すのは実際に展開できたときだけで、未知のスキル指定はタイトルにも本文のまま残す（[session-title.md](session-title.md#タイトルの作り方)）。
- BFF は本文の末尾に注記を合成してから `SessionStore.postMessage` へ渡す（[注記](#添付の注記)）。
- 圧縮中に送ると BFF の配送キューに積まれ、`queued: true` と `queueDepth` を返す（`sendId` は受け付けた時点で振り、`runId` は実行の開始時に確定する）。圧縮の終端処理の後に 1 回だけ pump し、先頭の送信を開始送信として次のランを始める（排他の判定は BFF の `compacting` フラグ。SDK は保存待ちの間 idle に見える）。
- 受理した送信は user entry が保存されるまで `sends.json` の `unsent` に残る（[session-files.md](session-files.md#sendsjson-と送信id--実行id-の注記)）。サーバー再起動でキューごと消えた分は payload の `pendingSends` に載り、クライアントは「未送信」として見せる（[frontend.md](frontend.md#チャット状態とレンダリング)）。
- 実行中の追加入力は BFF の配送キューを経て SDK の steering へ渡る。受付の成功は SDK への注入完了やモデルの追従を意味しない。受付済みの待機は受付順でまとめて渡り、SDK が次のモデル判断の前に全件注入する（[run-lifecycle.md](run-lifecycle.md#追加入力steeringの配送)）。

### `DELETE /api/sessions/:id/unsent/:sendId`

未送信メッセージを破棄する（再送せず表示からも消す）。末尾の ID は送信ID。

- 成功は `{ "ok": true }`。記録が無い（別タブで再送 / 破棄済み）は 404、配送中 / 実行中 / 注入済みの送信IDは 409（実行中の送信を消さない）。成功時は `resync` を 1 件配り、別タブの未送信表示を消す
- 本文はストアから消える。再送（POST /messages）は記録を残したまま実行するため、破棄だけが本文を捨てる経路になる

### `DELETE /api/sessions/:id/queue/:sendId`

待機中の 1 件だけを取り消す（末尾の ID は送信ID）。実行中のターンは止めず、他の待機も破棄しない。本文は記録に残るため、取り消した送信は payload の `pendingSends` で `unsent`（未送信）として見え、以降は既存の再送 / 破棄で扱う。

- BFF が保持する分はそのまま外す。SDK へ渡した分は、`clearQueue()` の前に実キュー件数から取り出し済みかを確定し、取り出し済みなら 409、実キューに残っていれば `clearQueue()` して残りを渡し直す。受付処理中の steering は、その完了を待ってから判定する。判定から `clearQueue()` までに await を挟まない（取り消せないものを取り消せたと返さないため）
- 成功は `{ "ok": true }`。件数や順位は応答に載せず、成功時に `resync` を 1 件配って揃える
- SDK が実キューから取り出した後（注入前でも）・実行中の開始送信は 409 `SDK が取り出したため取り消せません`。待機にも実行中にも無い（別タブが先に取り消した / 実行済み / 保存済み / 既に未送信）は 404 `待機中のメッセージが見つかりません`
- 送信の記録を保存できない構成（永続化なし）は 409 `送信の記録を保存できないため取り消せません` で断り、キューを触らない（取り消しの事後条件「未送信として残る」を満たせないため）
- 全破棄は `POST /stop`、記録ごと消すのは `DELETE /unsent/:sendId`。どちらも契約は変えない（`stop` の `queue_cleared` は出さず、実行の中断も伴わない）

### `/skill:` の展開

`/skill:<name> [args]` は **アプリ側 (BFF) で展開**してから `prompt()` へ渡す。SDK の `_expandSkillCommand` は BFF プロセスの `readFileSync` で本文を読むため、Docker（BFF に作業領域が無い）ではファイルスキルも組み込みスキルも展開できない（実ファイルが無い仮想パスのため）。

```
/skill:writer 3 行で書いて
```

```
<skill name="writer" location="/workspace/.agents/skills/writer/SKILL.md">
References are relative to /workspace/.agents/skills/writer.

（frontmatter を除いた SKILL.md の本文）
</skill>

3 行で書いて
```

- 形式は SDK の `_expandSkillCommand` と同じ（`parseSkillBlock` で読み直せる）。`location` は `read` に渡す値と同じ絶対パス（組み込みは `<root>/.u7agent/builtin-skills/...` の仮想パス）。引数はブロックの後に空行を挟んでそのまま渡す
- 本文の取得元はスコープ別: ファイル（共通 / プロジェクト）→ サンドボックスの `GET /v1/files/preview`、組み込み → BFF の registry。どちらも**送信時点**の内容を読む
- 名前は優先順位 `プロジェクト > 共通 > 組み込み` で一意に解決する（[一覧 API](#get-apisessionsidskills) と同じ解決を共有）。共通 / 組み込みスキルはセッションのエージェントスナップショットの `commonSkillNames` / `builtinSkillNames`（[api-catalog.md](api-catalog.md#エージェント定義のスキル許可リスト)）で絞られ、外した名前は未知の名前と同じに素通しする（エラーにしない）。`allowNaturalInvocation: false` は索引から外すだけで、展開は止めない（[api-catalog.md](api-catalog.md#自然文での発火)）。未知の名前、`/skill:` で始まらない本文も素通しする（SDK と同じ挙動）
- **本文は送信時点の内容**。ファイルが削除されていれば 404、2 MiB 超 / UTF-8 でない / バイナリは 400、サンドボックスへ到達できなければ 502 を返し、**メッセージは送らない**（切り詰めて黙って送るとモデルが読む本文が変わるため）
- 実行中（キュー / steering）に送った場合も同じ経路で展開する（`postMessage` が展開してから `SessionStore` へ渡す）
- 一覧のタイトルは展開前の入力（`/skill:writer 3 行で書いて`）から作る。履歴（`messages[].text`）と `run_start.prompt` には展開後の本文が入り、クライアントは user バブルでブロックを畳んで表示する（引数だけを吹き出しに残す）
- 二重展開はしない。展開結果は `<skill …>` で始まるため、SDK 側の展開（`/skill:` 接頭辞）には当たらない
- 本文に `</skill>` だけの行を書かない（ブロックの終端と区別できず、クライアントの畳み込み表示が崩れる。SDK の `parseSkillBlock` も同じ位置で切れる）

### 添付の注記

```
これを見て

<attached_files>
- /workspace/.u7agent/uploads/a1b2c3d4e5/photo-1.png
- /workspace/.u7agent/uploads/a1b2c3d4e5/report.pdf
</attached_files>
```

- 添付の保存先はセッションの作業ディレクトリの外（プロジェクト所属ではリポジトリの外）にあるため、注記は**絶対パス**で示す。モデルはそのパスで `read` する
- 履歴（`messages[].text`）と SSE の `run_start.prompt` には注記込みの本文が入る。組み立ては `server/src/attachments.ts` だけが行う
- タイトルは注記を除いた本文から作る（添付だけの送信では空のまま）
- クライアントは注記を分解し、user バブルにチップと本文を分けて表示する（コピーも注記を除いた本文が対象）。ローカルエコーは素の本文で先に出し、送信応答の `sendId` が付いた後（`echoSendId`）に `run_start` の注記込み本文へ差し替える。`run_start` が応答より先でも本文は控えておくため、別送信 (別タブ) の本文では差し替えない（`client/src/hooks/chatReducer.ts`。送信IDが無い旧経路だけ送信順の待ち行列と本文の正規形で突き合わせる）

### ask_user（`questions` / `answers`）

`ask_user`（[ask-user.md](ask-user.md)）の質問と回答は、`ToolCall.questions` / `ToolCall.answers` としてライブ（`tool_start` / `tool_end` / `run.toolCalls`）と履歴（`messages[].tools`）の両方に載る。`questions` は args から、`answers` は toolResult の `details` から導出し、どちらも**DTO に載せる前に** mask する（`content` に掛かる `tool_result` 拡張を通らないため）。

- `questions` は `{ question, header?, type?, options?, multiSelect?, placeholder? }` の配列（1〜4）。上限違反や形が壊れた args は DTO に載せず、通常のツール履歴のエラーとして見せる
- `answers` は `{ index, selected?, text?, skipped? }` の配列。`skipped` は質問ごとの「回答しない」で `selected` / `text` とは排他。停止・中止では空配列になり、カードを「回答なしで終了」として復元できる（未回答 = キーが無い、とは区別する）
- `run.toolCalls` は待機中もこのフィールドを持ち、リロード / SSE 再接続の復帰に使う。クライアントは `answers` が無く `done: false` のカードを回答待ちとして扱う

### investigate（調査の委譲）

`investigate`（[subagent.md](subagent.md)）は BFF ローカルのツールで、引数は `prompt` 1 本だけ。親のランでは通常のツール呼び出し（`tool_start` / `tool_end` と `messages[].tools`）として見え、完了すると要約カードになる。**結果のための専用 DTO フィールドは持たず**、`content`（子の報告）と `details`（内訳）だけで表す。

- 打ち切り・失敗（子自身の失敗を含む）も `isError: true` で返り、`details` に終了理由が載る
- 子は読み取り専用の使い捨てセッションで、親の `session.jsonl` にも `SessionStore` にも残らない（親には toolResult だけが残る）
- 打ち切りは親の stop（`POST /stop`）と同じ経路（`AbortSignal`）。`stop` に専用のフックは無い
- 実行中の進捗は SSE の `tool_progress` でだけ届き、ライブの `ToolCall.progress`（現在の活動 + 子の本文末尾）になる。**payload の `run.toolCalls` には載らない live 専用**で、リロード / SSE 再接続では消える（残るのは `tool_start` / `tool_end` のカードだけ）

## `POST /api/sessions/:id/questions/:toolCallId/answer`

`ask_user` の回答。質問ごとに `selected`（選択した label）/ `text`（自由記入）/ `skipped: true`（回答しない）のどれかを載せ、**全質問に 1 つずつ**必要（質問数と合わない・範囲外・重複 index は 400）。`skipped` と `selected` / `text` の同時指定も 400。`text` は 2000 文字まで。

```json
// request
{ "answers": [{ "index": 0, "selected": ["PostgreSQL"] }, { "index": 1, "text": "本番は東京リージョン" }, { "index": 2, "skipped": true }] }
// response (200)
{ "ok": true }
```

- 成立するのは 1 回だけ。同じ `toolCallId` への 2 回目は 409（別タブの先勝ち）、回答待ちでない（停止済み・再起動で消えた）は 404。`selected` の label が質問の選択肢に含まれるかの検証はしない（自由記入と同じ扱い）
- 回答はツールの戻り値としてモデルへ渡る。`content` は `tool_result` 拡張で mask され、`details` は DTO 構築時に mask する（[secrets.md](secrets.md#レイヤー)）。回答待ちの間はランが `running` のままで、手動 compaction は 409 になる
- 認可・CSRF は他の `POST /api/*` と同じ経路（`bodyGuard` + Origin / `Sec-Fetch-Site` 検査）。回答の権限はセッションの閲覧と同じで、新しい権限は足さない

## `GET /api/sessions/:id/skills`

セッションで使えるスキルの一覧（チャットの入力補助）。**本文は載せない**（送信時に取り直す）ため、一覧と優先順位の表示に使う。

```json
{
  "sessionId": "…",
  "cwd": "proj",
  "projectSkills": true,
  "skills": [
    {
      "name": "writer",
      "description": "文章を書くときに使う",
      "scope": "project",
      "location": "/workspace/proj/.agents/skills/writer/SKILL.md",
      "relativePath": "proj/.agents/skills/writer/SKILL.md",
      "disableModelInvocation": false,
      "shadowed": false,
      "shadowedBy": null,
      "shadows": ["/workspace/.agents/skills/writer/SKILL.md"]
    }
  ]
}
```

- `scope` は `project` / `user`（共通）/ `builtin`。並びは優先順位 `project > user > builtin`。`user` はセッションのエージェントスナップショットの `commonSkillNames`、`builtin` は `builtinSkillNames` で絞られ、どちらも未指定なら全件、`[]` なら 0 件になる（[api-catalog.md](api-catalog.md#エージェント定義のスキル許可リスト)）
- `disableModelInvocation` は実効値で、スキルファイルの `disable-model-invocation` か、エージェントスナップショットの `allowNaturalInvocation: false` のどちらかで true になる（[api-catalog.md](api-catalog.md#自然文での発火)）
- `cwd` はセッションの作業ディレクトリ（root 相対）。`projectSkills` はプロジェクトスキルを探索するセッションか（未所属のスクラッチと root 直下は `false`）
- `location` は `read` に渡す値（組み込みは実体の無い仮想パス `.u7agent/builtin-skills/<name>/SKILL.md`）。`relativePath` は root の外のみ `null`
- 同名は優先順位で一意化する。負けた行（上書きされた組み込み）は `shadowed: true` と `shadowedBy`（優先される側の `location`）で示し、採用された行は `shadows`（隠している側の `location`）を持つ。`shadows` に入るのは**ファイルスキル同士の重複**。許可リストは一意化の**前**に当てるため、外した共通 / 組み込みスキルと同名の下位側（プロジェクト / 共通）は浮上して有効になる（影の組み合わせ自体が消える）。**ファイルの改名・削除・マージはしない**
- 404（セッションなし）/ 503（サンドボックス未設定）/ ファイルスキルの発見失敗は 502（接続失敗・認証失敗・サンドボックス側 5xx・本文が契約外はサンドボックスクライアントが 502 に寄せる。不正な dir の 400 だけそのまま）。**組み込みだけを返して黙って縮退しない**（使えるスキルを見せる場所なので、取れないことはエラーで見せる）。セッション作成と `/skill:` の展開は従来どおり縮退する（作成を止めない）

## `GET /api/skills/session`

セッション未確定（新規チャット）のスキル一覧。入力欄のスキルピッカーを、セッションを作る前に開けるようにする。解決は `GET /api/sessions/:id/skills` と同じ `resolveSessionSkills` を共有し、`sessionId` を外した同じ形を返す。

```
GET /api/skills/session?projectId=<id>&agentId=<id>
```

```json
{
  "cwd": "proj",
  "projectSkills": true,
  "skills": [ … ]
}
```

- `projectId` 省略は未所属、`agentId` 省略はビルトインエージェント。未知の id はセッション作成と同じ 400。`cwd` は指定したプロジェクトの cwd で、未所属は `""`（セッション確定後のスクラッチ `.u7agent/sessions/<id>` とは別の値になる）。`projectSkills` はプロジェクトスキルを探索するか（未所属は `false`）
- 解決に渡すのは `relativeCwd = project.cwd ?? ""`、`commonSkillNames = agentInfo.commonSkillNames`、`builtinSkillNames = agentInfo.builtinSkillNames`。エージェントの解決はセッション作成と同じヘルパー（`resolveAgentSkills`）を使い、client へ二重実装しない。これで新規チャットのピッカーと、同じ選択で作ったセッションの一覧（`GET /api/sessions/:id/skills`）が同じ見え方になる
- プロジェクトを指定したときは、作成と同じ条件（永続化あり）で登録ディレクトリの存在を確かめ、無ければ 400（`server/src/sessions.ts` の `requireProjectDir` を共有）。サンドボックス未設定は 503 で、組み込みだけへは縮退させない（その一覧から選んだ `/skill:` も `createSession` の 503 で送れないため）
- 探索の失敗の扱いは `GET /api/sessions/:id/skills` と同じ（置き場が無い 404 は空、サンドボックス由来はその status、`SandboxRequestError` 以外は 500）
- 内容は作成前の選択で解決した**現在の**ファイルになる。ファイルスキルは一覧のたびに探索し直す
- セッションが確定したら `GET /api/sessions/:id/skills` へ切り替える。復元済みセッションは `meta.projectCwd` と保存済みスナップショットで解決するため、プロジェクトの登録が解除・消失していてもプレビューへは戻らない

## `POST /api/sessions/:id/files`

選択時の即時アップロード。`Content-Type` を見ずに本文を raw ストリームとしてサンドボックスの `POST /v1/files/upload` へ転送する（`/api/*` の `bodyGuard` を通さないため、JSON / base64 の上限や text 化の影響を受けない）。

```
POST /api/sessions/:id/files?name=photo.png
<body: ファイルのバイト列>
```

```json
// response (201)
{ "sessionId": "…", "path": ".u7agent/uploads/a1b2c3d4e5/photo.png", "name": "photo.png", "renamed": false, "size": 12345 }
```

- `path` は root 相対。サンドボックスも root 相対を返すため、BFF はそのセッションの保存先（[session-files.md](session-files.md#スペースごとの配置)）に解決できることを確かめてそのまま返す（外を指す・`..` を含む・別セッションの応答は契約違反として 502）。raw 表示 URL はこの値をそのまま `GET /api/files/raw` の `path` に使う
- 保存先は所属スペースの添付置き場（[session-files.md](session-files.md#スペースごとの配置)）。同名ファイルは上書きせず `name-1.ext` 形式で連番にする（詳細は [session-files.md](session-files.md#添付ファイルチャットからのアップロード)）
- 400（`name` が不正）/ 404（セッションなし）/ 413（100 MiB 超。`Content-Length` で分かるときは本文を送らずに返す）/ 503（サンドボックス未設定）/ 502（サンドボックスへ到達できない・応答が契約外）
- 上限は 1 ファイル 100 MiB、ファイル名 200 文字（いずれも最終判定はサンドボックス側）
