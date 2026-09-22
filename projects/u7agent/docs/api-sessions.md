# セッション API

規約と索引は [api.md](api.md) を参照する。設計の背景は [run-lifecycle.md](run-lifecycle.md)、compaction は [compaction.md](compaction.md)、Model / Effort は [model-effort.md](model-effort.md) を正とする。

## `GET /api/sessions`

セッション一覧（最終使用の新しい順）。

```json
{
  "sessions": [
    {
      "sessionId": "…",
      "title": "README をレビューして",
      "agentId": "agent-general",
      "agentName": "汎用アシスタント",
      "status": "running",
      "queueDepth": 0,
      "messageCount": 4,
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000001000,
      "model": "zai/glm-5.3-flash",
      "projectId": "…"
    }
  ]
}
```

`projectId` は所属プロジェクト（未所属はキーを省略する）。所属は保存された `projectCwd` をプロジェクト一覧と突き合わせて読み取り時に解決するため、プロジェクトを解除すると配下セッションは未所属として返る（セッションと履歴は残る）。復元したセッションも同じ規則で解決する。

`messageCount` は表示メッセージ数（`user` と、テキストを持つ `assistant`。ツール呼び出しだけのターンは数えない）で、履歴の生件数ではない。未ロードのセッションは保存された `meta.json` の値、ロード済みは現在の履歴から数えた値を返す（ずれの扱いは [session-files.md](session-files.md)）。

## `POST /api/sessions`

セッション作成。body は任意。

```json
{ "agentId": "agent-general", "model": { "provider": "openai", "id": "gpt-5.5" }, "thinkingLevel": "high", "projectId": "…" }
```

- `agentId` は optional。省略するとビルトインの汎用アシスタント（`agent-general`）を使うので、ユーザー定義が 0 件でも作成できる（[api-catalog.md](api-catalog.md#ビルトインの汎用エージェント)）。未知の id は 400。
- `model` / `thinkingLevel` はそれぞれ optional（`null` は 400）。省略した項目は「エージェント定義 → アプリ既定」の順に解決する。
- `projectId` は optional。省略したセッションは未所属になる。未知の `projectId` は 400（未所属へは落とさない）。
- セッションの作業ディレクトリは、所属プロジェクトがあれば登録ディレクトリ（`project.cwd`）、未所属ならワークスペース root 配下の `.u7agent/sessions/<id>`。以降のツール実行とファイル一覧の起点になり、`write` / `edit` の書き込み範囲でもある（共通スキル置き場 `<root>/.agents/skills` は別枠。 [projects.md](projects.md#write--edit-の書き込み範囲)）。プロジェクトのディレクトリは作らず存在確認だけを行い、無ければ 400。未所属のスクラッチは作成時にサンドボックスの `POST /v1/dirs` で作る。会話の永続化が有効なときは `meta.json` / `session.jsonl` も同じ id で会話ストアへ作る（[session-files.md](session-files.md)）。所属を後から変える API は無い。詳細は [projects.md](projects.md#セッション-cwd)。
- 明示されたモデルは利用可能一覧の provider/id と厳密照合し、利用不能なら 400、利用可能モデル自体がゼロなら 503。いずれも pi SDK のセッション作成前に拒否する。
- 作成時に指定した値はそのチャット内だけに適用され、定義や他のチャットへは波及しない。201 でセッションペイロードを返す。

## `GET /api/sessions/:id`

セッションペイロード。会話履歴（`messages`）と実行状態（`status` / `run`）、SSE のカーソル（`lastSeq`）を含む。

```json
{
  "sessionId": "…",
  "status": "running",
  "queueDepth": 0,
  "lastSeq": 42,
  "eventGeneration": "a1b2c3d4",
  "title": "…",
  "model": "deepseek/deepseek-v4-flash",
  "thinkingLevel": "high",
  "supportsThinking": true,
  "availableThinkingLevels": ["off", "low", "high", "max"],
  "cwd": ".u7agent/sessions/3f2b9a1c7d",
  "projectId": "…",
  "agent": { "id": "…", "name": "…", "skills": ["…"] },
  "run": {
    "id": "…",
    "status": "running",
    "startedAt": 1700000000000,
    "toolCalls": [{ "id": "…", "name": "read", "args": "…/gh/SKILL.md", "done": true, "isError": false, "output": "…", "skill": { "id": "…", "name": "gh", "path": "/workspace/.agents/skills/gh/SKILL.md" } }]
  },
  "context": { "tokens": 68000, "contextWindow": 200000, "percent": 34 },
  "messages": [
    { "role": "user", "text": "…", "at": 1700000000000 },
    {
      "role": "assistant",
      "text": "…",
      "stopReason": "stop",
      "at": 1700000001000,
      "usage": {
        "input": 8200,
        "output": 512,
        "cacheRead": 7900,
        "cacheWrite": 300,
        "reasoning": 128,
        "totalTokens": 17040,
        "cost": { "input": 0.001, "output": 0.002, "cacheRead": 0.0002, "cacheWrite": 0.0001, "total": 0.0021 }
      },
      "metrics": { "durationMs": 1800, "ttftMs": 900, "tokensPerSecond": 42.3 },
      "skillLoads": [
        {
          "id": "…",
          "name": "gh",
          "path": "/workspace/.agents/skills/gh/SKILL.md",
          "offset": 5,
          "limit": 20,
          "isError": true
        }
      ]
    }
  ],
  "compactions": [
    {
      "id": "…",
      "parentId": "…",
      "timestamp": "2026-09-13T04:05:06.789Z",
      "summary": "これまでの会話の要約…",
      "firstKeptEntryId": "…",
      "tokensBefore": 68000,
      "usage": {
        "input": 12000,
        "output": 800,
        "cacheRead": 30000,
        "cacheWrite": 0,
        "totalTokens": 42800,
        "cost": { "input": 0.002, "output": 0.003, "cacheRead": 0.001, "cacheWrite": 0, "total": 0.006 }
      },
      "reason": "threshold",
      "estimatedTokensAfter": 9500,
      "beforeMessageIndex": 4
    }
  ]
}
```

`model` / `thinkingLevel` は pi SDK のセッションが持つ実効値（`thinkingLevel` は SDK 補正後）。`supportsThinking` と `availableThinkingLevels` はその実効モデルの能力を SDK の公開ヘルパーから引いたもの。`agent` は作成時点のスナップショットなので、定義を編集・削除しても既存チャットの表示は変わらない。

`cwd` はワークスペース root 相対の作業ディレクトリ（プロジェクト所属は `projectCwd`、未所属は `.u7agent/sessions/<id>`）。ツール実行と `GET /api/files` の結果はこのディレクトリを起点に組み立てる。`write` / `edit` はこのディレクトリと `<root>/.agents/skills` の内側にだけ書ける（[projects.md](projects.md#write--edit-の書き込み範囲)）。`health.cwd` は root の絶対パス（表示用）で意味が違う。`projectId` は所属プロジェクト（未所属はキーを省略）。復元時は `meta.projectCwd` から `cwd` を解決し、登録が解除・消失していてもそのディレクトリを使う。

`eventGeneration` は SSE の世代（[イベント購読](#get-apisessionsidevents) を参照）。`lastSeq` と組でカーソルの整合判定に使う。

`messages[].at` は pi SDK が履歴に持つメッセージの作成時刻（epoch ms）。assistant は生成開始時刻で、完了時刻ではない。SDK が時刻を持たない履歴ではキーを省略する（受け手は時刻無しでも表示を壊さない）。

`messages[].usage` は SDK の `AssistantMessage.usage` をそのまま通したもの（`cost` は pi-ai の `calculateCost` 済み。料金表が無いモデルは 0）。`cacheWrite1h` / `reasoning` は報告するプロバイダだけが返す。プロバイダが usage を報告しないときはキーを省略し、0 に置き換えない（受け手は数字を出さない）。

`messages[].metrics` は BFF がイベントの到着時刻で測った応答時間。SDK は完了時刻を持たないため BFF 側でしか作れない。`durationMs` は `message_start`(assistant) から `message_end` まで、`ttftMs` は最初の text / thinking delta まで（delta が無ければ省略）、`tokensPerSecond` は `output` を最初の delta からの時間で割った値（スパンが 0 なら `durationMs`、それも 0 なら省略）。ツールループで assistant メッセージが複数あるときはメッセージごとに付く。

### スキル読み込み（`skillLoads` / `skill`）

`messages[].skillLoads` と `run.toolCalls[].skill` は、`read` で **basename が `SKILL.md`** の呼び出し（スキル読み込み）を示す導出値。判定は server の純関数 `classifySkillRead()` 1 箇所に集約し、履歴（`projectMessages()`）とライブ（`tool_execution_start`）で共有する。専用の保存フィールドは持たず、pi entry から毎回導出する（[persistence.md](persistence.md)）。

- `name` は解決後の絶対パスの**親ディレクトリ名**（pi ネイティブと同じ）。frontmatter の `name` とは一致しないことがあり、`foo/SKILL.md` に `name: bar` があっても行は `[skill] foo` になる（一覧 / `/skill:` は frontmatter の `name` を使うため食い違い得る）。`path` は解決後の絶対パス（pi の展開表示は cwd 相対だが、ライブ / 履歴で同じ値にするため絶対で統一する）。`offset` / `limit` は `read` の引数をそのまま持つ
- cwd は絶対 session cwd（`workspaceAbs(rootCwd, record.workdir)`）に統一する。対応する path は絶対 / 相対 / `.` / `..` のみで、`~` 展開・`@` 接頭辞・`file://`・Unicode スペース正規化は非対応（該当しない）。組み込みの仮想パス（`.u7agent/builtin-skills/<name>/SKILL.md`）も同じ規則で成立する（厳密な name 照合はしない）
- `skillLoads` は「**このバブルに出す分**（繰り上げ分を含む）」。`isDisplayableMessage()` は本文を要求するため、`read` だけの assistant メッセージは表示集合から落ち、**同じ user ターン内の次の表示可能な assistant メッセージへ繰り上げる**（メッセージ順 → part 順、繰り上げ分が先）。次の user メッセージは越えず、ターン内に表示可能なメッセージが無ければ落とす（既知の制限）。繰り上げても `messages` の件数と `messageCount` は変えない
- `isError` は省略可能で、省略 = ロード扱い。履歴は `toolResult` を `toolCallId` で join して `isError: true` のときだけ載せる。`toolResult` が無い read は、その read を含む assistant メッセージの `stopReason === "aborted"` なら発火扱いにしない（abort で一度も実行されていない）。それ以外の欠落（crash / restart・compaction 境界）は実行済みとしてロード扱いにする
- ライブの `ToolCall.skill` は `tool_execution_start` の時点で結果が無いため `isError` を載せない（行のエラー表示はカードの位相が担う）。実行済みで表示メッセージに載る read に限り、ライブの `ToolCall.skill` と履歴の `skillLoads[]` は同じ値（`id` / `name` / `path` / `offset` / `limit`）になる
- `name` / `path` は他の文字列と同じく、分類（basename 判定）の後にマスクしてから配る（[secrets.md](secrets.md)）
- abort で未実行の read はライブでは `tool_end` が来ずカードが `running` のまま残る（履歴側は発火扱いにしないため差異が残る。既知の制限）

`context` は SDK の `getContextUsage()`（`tokens` / `contextWindow` / `percent`）。compaction 直後は `tokens` と `percent` が `null` になる。SDK がこの API を持たないときはキーを省略する。SDK は `message_end` を購読者へ配った後に履歴へ入れるため、`usage` イベント時点の `context` は直前の応答までの値（compaction 直後は不明値）になる。今回の応答を反映した確定値は `run_end` の `context` で配り、リロード / resync はこの payload を正とする。セッションが未作成のとき（チャット開始前）は `context` のキー自体が無く、UI は Context ゲージを出さない。作成済み・未送信のセッションは SDK が `tokens: 0` / `percent: 0` を返すため 0% として出る。

`compactions` は会話の圧縮（compaction）の履歴を古い→新しいの順で持つ（圧縮が無ければ `[]`）。要素は pi SDK の `CompactionEntry` をそのまま写せる形（`id` / `parentId` / `timestamp` / `summary` / `firstKeptEntryId` / `tokensBefore` / `usage` / `fromHook`）で、表示用の文字列へ潰さずアプリ独自の連番 ID も振らない（`id` は SDK entry の id で、永続化後も一意に参照できる）。

- `summary` は他の出力と同じく、既知の秘密値を `[REDACTED]` に置き換えてから配る。SDK 側の entry は書き換えない
- `beforeMessageIndex` は区切りを置く `messages` の index（この index の手前。`messages.length` なら末尾）で、**最新の 1 件だけ**が持つ。位置は `messages` と同じ集合を数えて求め（entry は「compaction より手前か」の判定だけに使う）、SDK が context を組み替えても `messages` とずれない。SDK は最新の compaction しか context に残さないため、以前の圧縮位置は `messages` から復元できない。回数は `compactions.length` で示し、過去分は要約の一覧として読む
- `reason`（`manual` / `threshold` / `overflow`）と `estimatedTokensAfter` は `CompactionEntry` に保存されず `compaction_end` にしか無いため、BFF がイベント受信時に entry id ごとに控えて payload 組み立て時に合成する。控えは揮発で、BFF の再起動後はキーを省略する（`reason` が無くても `tokensBefore` だけで表示は成立する）
- `tokensBefore` は最後の assistant の usage と末尾メッセージの推定を足した SDK の `estimateContextTokens()` の値で、プロバイダの実測そのものではない。`estimatedTokensAfter` は `estimateMessagesTokens()` の推定値で、初期 UI には出さない（Context ゲージは provider 実測のため、並べると食い違いに見える）
- 圧縮で context から外れたメッセージは `messages` から消える（圧縮前の元メッセージは配らない）。`messages` に role `compactionSummary` のメッセージは載せない

## `PATCH /api/sessions/:id/settings`

チャット単位の Model / Effort 変更。同じ SDK セッション・会話履歴・タイトルを保つ。

```json
// request (片方だけでもよい)
{ "model": { "provider": "openai", "id": "gpt-5.5" }, "thinkingLevel": "high" }
// response (200): セッションペイロード
```

- 省略した項目は現在値維持。空 body・`null`・不正な値・利用不能なモデルは 400、存在しないセッションは 404。
- モデルだけ変更するときは変更前の実効 Effort を退避して SDK 切替後に再適用する。両方指定したときは要求した Effort を再適用する。SDK が非対応値を補正するため、応答は補正後の実効値になる。
- 実行中・送信待ちキューあり・SDK が非 idle・別の設定変更中のときは 409（値は変わらない）。変更中は同セッションへの送信も 409 になり、変更完了後に解除される。
- 変更は `resync` イベントで購読中のクライアントへ同期する。

## `POST /api/sessions/:id/messages`

メッセージ送信。**202 で即時返却**し、ランは裏で続く。実行中に呼ぶとキューに積まれる（最大 10 件、超過は 429）。

```json
// request
{ "text": "README を読んで改善案を 3 つ" }
// request (添付あり)
{ "text": "これを見て", "attachments": [".u7agent/uploads/a1b2c3d4e5/photo-1.png", ".u7agent/uploads/a1b2c3d4e5/report.pdf"] }
// response (202)
{ "sessionId": "…", "status": "running", "queued": false, "queueDepth": 0, "runId": "…" }
```

- `attachments` は root 相対のパスで、そのセッションの保存先 `<appdir>/uploads/<sessionId>/` 配下だけを許可する（`./` は正規化、`..`・絶対パス・ディレクトリ自体・別セッションの保存先は 400）。最大 10 件、文字列以外は 400。
- `text` は空でも添付があれば送れる（本文も添付も無いときだけ 400）。
- `text` が `/skill:` で始まるときは、BFF が本文ブロックへ展開してから送る（[`/skill:` の展開](#skill-の展開)）。
- BFF は本文の末尾に注記を合成してから `SessionStore.postMessage` へ渡す（[注記](#添付の注記)）。

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

- 形式は SDK の `_expandSkillCommand` と同じ（`parseSkillBlock` で読み直せる）。`location` は `read` に渡す値と同じで、ファイル / 組み込みは絶対パス（組み込みは仮想パス）、カタログは実ファイルが無いため `catalog:<name>` になり「References are relative to …」行は入らない。引数はブロックの後に空行を挟んでそのまま渡す
- 本文の取得元はスコープ別: ファイル（共通 / プロジェクト）→ サンドボックスの `GET /v1/files/preview`、組み込み → BFF の registry、カタログ（Agent 割り当て）→ セッションの `promptSnapshot`（旧 `<skill>` と新 `<agent_skill>` の両方を受け付け、タグではなく `name` 属性で引く）
- 名前は優先順位 `プロジェクト > 共通 > 組み込み > カタログ` で一意に解決する（[一覧 API](#get-apisessionsidskills) と同じ解決を共有）。未知の名前、`/skill:` で始まらない本文は素通しする（SDK と同じ挙動）
- **本文は送信時点の内容**。ファイルが削除されていれば 404、256 KiB 超 / UTF-8 でない / バイナリは 400、サンドボックスへ到達できなければ 502 を返し、**メッセージは送らない**（切り詰めて黙って送るとモデルが読む本文が変わるため）
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
- クライアントは注記を分解し、user バブルにチップと本文を分けて表示する（コピーも注記を除いた本文が対象）。ローカルエコーは素の本文で先に出し、`run_start` が届いたら注記込みへ差し替える（`client/src/hooks/chatReducer.ts`。送信順の待ち行列で同じ本文を続けて送っても取り違えない）

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

- `scope` は `project` / `user`（共通）/ `builtin` / `catalog`（エージェント定義のスキル）。並びは優先順位 `project > user > builtin > catalog`
- `cwd` はセッションの作業ディレクトリ（root 相対）。`projectSkills` はプロジェクトスキルを探索するセッションか（未所属のスクラッチと root 直下は `false`）
- `location` は `read` に渡す値（カタログは `catalog:<name>`）。`relativePath` は表示用で、root の外とカタログは `null`
- 同名は優先順位で一意化する。負けた行（組み込みの上書きとカタログ）は `shadowed: true` と `shadowedBy`（優先される側の `location`）で示し、採用された行は `shadows`（隠している側の `location`）を持つ。`shadows` に入るのは**ファイルスキル同士の重複**で、カタログは常に敗者側にしか立たない。**ファイルの改名・削除・マージはしない**
- カタログの `description` はセッションのエージェントスナップショット（`agent.skills`）から、本文は `promptSnapshot` から引く。どちらも作成時点の内容で、定義を編集してもこのセッションの一覧は変わらない
- 404（セッションなし）/ 503（サンドボックス未設定）/ ファイルスキルの発見失敗は 502（接続失敗・認証失敗・サンドボックス側 5xx・本文が契約外はサンドボックスクライアントが 502 に寄せる。不正な dir の 400 だけそのまま）。**組み込みだけを返して黙って縮退しない**（使えるスキルを見せる場所なので、取れないことはエラーで見せる）。セッション作成と `/skill:` の展開は従来どおり縮退する（作成を止めない）

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

- `path` は root 相対。サンドボックスも root 相対を返すため、BFF はそのセッションの保存先（`<appdir>/uploads/<sessionId>/`）に解決できることを確かめてそのまま返す（外を指す・`..` を含む・別セッションの応答は契約違反として 502）。raw 表示 URL はこの値をそのまま `GET /api/files/raw` の `path` に使う
- 保存先は所属に関係なく `<appdir>/uploads/<sessionId>/`。同名ファイルは上書きせず `name-1.ext` 形式で連番にする（詳細は [session-files.md](session-files.md#添付ファイルチャットからのアップロード)）
- 400（`name` が不正）/ 404（セッションなし）/ 413（100 MiB 超。`Content-Length` で分かるときは本文を送らずに返す）/ 503（サンドボックス未設定）/ 502（サンドボックスへ到達できない・応答が契約外）
- 上限は 1 ファイル 100 MiB、ファイル名 200 文字（いずれも最終判定はサンドボックス側）

## `GET /api/sessions/:id/events`

SSE（`text/event-stream`）でイベントを購読。カーソルは `Last-Event-ID` ヘッダ（`<generation>:<seq>`）→ query の `generation` + `after` → `resync` の優先順位で解決する。世代（payload の `eventGeneration`）が現在と一致し、seq がバッファ範囲内のときだけ差分をリプレイし、それ以外は `resync`（セッション全体のペイロード）を 1 件送る。再起動や sweep の復元で seq が 0 に戻っても、古いタブは 1 回の resync で整合する。

接続直後と、以降 15 秒ごとに `ping`（可視イベント）を送る。`id` を付けないため `Last-Event-ID` は動かない。クライアントはこれを生存確認にだけ使い、状態には流さない（dev の Vite プロキシは upstream が落ちても接続を閉じないので、無音を切断とみなして張り直す）。

イベントタイプ:

| イベント | data |
| --- | --- |
| `run_start` | `{ runId, prompt, startedAt }`（`startedAt` は payload の `run.startedAt` と同じ値） |
| `text` | `{ delta }` |
| `tool_start` / `tool_end` | `{ id, name, args, skill? }` / `{ id, name, isError, output }`（`skill` は `run.toolCalls[].skill` と同じスキル読み込み。結果が無い時点なので `isError` は載らない） |
| `status` | `{ state, text }`（考え中 / ツール実行中 / 再試行中 など） |
| `queued` | `{ position, queueDepth, prompt }` |
| `queue_cleared` | `{}` |
| `run_end` | `{ runId, status, error, messageCount, queueDepth, context? }`（`messageCount` は一覧 API と同じ表示メッセージ数） |
| `usage` | `{ usage?, metrics?, context? }`（assistant の `message_end` ごとに 1 件。usage はプロバイダが報告したときだけ、metrics は BFF 計測、context は SDK の `getContextUsage()` だが履歴反映前なので確定値は `run_end` 側） |
| `compaction` | `{ compaction, count }`（`compaction_end` ごとに 1 件。`compaction` は payload の `compactions` の要素 1 つ、`count` はその時点の累計回数。続けて同じ状態を持つ `resync` が届く（送信メッセージを履歴へ入れる前に圧縮が走った場合は、そのメッセージが入ってから届く）。`result` が無い / `aborted` / `errorMessage` ありのときは `compaction` も `resync` も配らない） |
| `resync` | セッションペイロード全体（バッファを逃した場合・世代が一致しない場合） |
| `session_deleted` | `{ sessionId }`（削除時。送出後に接続を閉じる） |
| `ping` | `{}`（接続直後と 15 秒ごとの生存確認。`id` 無し = カーソルを動かさない） |

テキスト系イベント（`text` / `tool_start` / `tool_end` / `run_start` / `queued` / `run_end` のエラーや `resync` の `messages`・`compactions[].summary`、`compaction` の `compaction.summary` など）は、既知のプロバイダーAPIキーの値が `[REDACTED]` に置換されて配信される。対象キーと保証範囲は [secrets.md](secrets.md) を参照。

## `POST /api/sessions/:id/stop`

実行中のランを中断し、待機キューを破棄する。`{ ok: true, status: "stopped" }` を返す。旧 `POST /api/sessions/:id/abort` も同じ動作のエイリアス。

## `DELETE /api/sessions/:id`

セッションを削除する。停止 + 会話ストアの履歴削除を行い、購読中の SSE には `session_deleted` が通知される。作業ディレクトリ（プロジェクト所属は登録ディレクトリ、未所属は `.u7agent/sessions/<id>`）と添付（`.u7agent/uploads/<id>`）は残る。未ロードのセッションは SDK セッションを開かずに消せる（モデル未認証・JSONL 破損でも削除できる）。未知の id は 404。
