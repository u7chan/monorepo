# セッション API

規約と索引は [api.md](api.md) を参照する。設計の背景は [run-lifecycle.md](run-lifecycle.md)、compaction は [compaction.md](compaction.md)、Model / Effort は [model-effort.md](model-effort.md) を正とする。

## スペース文脈

作成の本文以外は、全会話 API（SSE・添付も含む）へ `?spaceId=<id>` を渡す。省略は通常 `default`。所属不一致は SDK 復元や変更の前に 404 とする（[api.md](api.md#スペース)）。一覧は要求スペースだけを返し、未指定一覧に追加スペースを混ぜない。`SessionSummary` / `SessionPayload` は正規化した `spaceId` を返す。

`POST /api/sessions` の optional `spaceId` は本文で指定し、会話の所属は作成後に変更しない。追加スペースと `projectId` の併用は 400。追加スペースの cwd は `.u7agent/spaces/<spaceId>/sessions/<sessionId>`、添付は同階層の `uploads/<sessionId>` とし、その会話の添付だけを送信時に許容する。通常の cwd・添付・既存参照は変えない。未確定会話の `GET /api/skills/session` も query の所属を確認し、追加スペースでは `projectId` を拒否する。

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
      "pinned": false,
      "messageCount": 4,
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000001000,
      "model": "<provider>/<id>",
      "projectId": "…"
    }
  ]
}
```

`pinned` はサイドバーで固定するかを示す（常に boolean）。`projectId` は所属プロジェクト（未所属はキーを省略する）。所属は保存された `projectCwd` をプロジェクト一覧と突き合わせて読み取り時に解決するため、プロジェクトを解除すると配下セッションは未所属として返る（セッションと履歴・ピン状態は残る）。復元したセッションも同じ規則で解決する。

`messageCount` は表示メッセージ数（`user` と、テキストを持つ `assistant`。ツール呼び出しだけのターンは数えない）で、履歴の生件数ではない。未ロードのセッションは保存された `meta.json` の値、ロード済みは現在の履歴から数えた値を返す（ずれの扱いは [session-files.md](session-files.md)）。

## `POST /api/sessions`

セッション作成。body は任意。

```json
{ "agentId": "agent-general", "model": { "provider": "<provider>", "id": "<id>" }, "thinkingLevel": "high", "projectId": "…" }
```

- `agentId` は optional。省略するとビルトインの汎用アシスタント（`agent-general`）を使うので、ユーザー定義が 0 件でも作成できる（[api-catalog.md](api-catalog.md#ビルトインの汎用エージェント)）。未知の id は 400。
- `model` / `thinkingLevel` はそれぞれ optional（`null` は 400）。省略した項目は「エージェント定義 → アプリ既定」の順に解決する。アプリ既定が未設定（`health.defaultModelUnset`）の間はモデルを指定しない作成が 503 になる（候補の先頭では代用しない）。
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
  "pinned": false,
  "lastSeq": 42,
  "eventGeneration": "a1b2c3d4",
  "title": "…",
  "model": "<provider>/<id>",
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
    "retry": { "phase": "waiting", "attempt": 1, "maxAttempts": 2, "retryAt": 1700000004000, "reason": "rate_limit" },
    "totalRetryCount": 1,
    "toolCalls": [{ "id": "…", "name": "read", "args": "…/gh/SKILL.md", "done": true, "isError": false, "output": "…", "skill": { "id": "…", "name": "gh", "path": "/workspace/.agents/skills/gh/SKILL.md" } }]
  },
  "serverNow": 1700000002100,
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
      "tools": [
        { "id": "…", "name": "bash", "args": "$ ls -la", "isError": false, "done": true, "output": "file list" }
      ],
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
  ],
  "pendingSends": [
    { "runId": "…", "text": "送信が保存されなかった本文", "at": 1700000000000, "state": "unsent" },
    { "runId": "…", "text": "待機中の本文", "at": 1700000000001, "state": "queued", "position": 2 }
  ]
}
```

`model` / `thinkingLevel` は pi SDK のセッションが持つ実効値（`thinkingLevel` は SDK 補正後）。`supportsThinking` と `availableThinkingLevels` はその実効モデルの能力を SDK の公開ヘルパーから引いたもの。`agent` は作成時点のスナップショットなので、定義を編集・削除しても既存チャットの表示は変わらない。

`status` は `idle` / `running` / `queued` / `compacting` / `completed` / `stopped` / `error`。`compacting` は手動圧縮の実行中で、SDK の実行中だけでなく**保存待ち**も含む（排他の正は BFF のフラグ。詳細は [compaction.md](compaction.md#手動圧縮)）。`compactionStartedAt` はその開始時刻（epoch ms）で、`status` が `compacting` のときだけ載る（終端の `resync` では載せない）。経過時間の起点はこの値を使い、`run.startedAt` は再利用しない。

`serverNow` は payload を組み立てたサーバー基準時刻（epoch ms）。`run.retry.retryAt` との差でクライアントが待機の残り時間を出すための値で、ブラウザの時計と直接比較してはならない（リロード / SSE 再接続 / 別タブでも同じ残り時間を復元する。詳細は [run-lifecycle.md](run-lifecycle.md#再試行状態の配信と復元)）。

`run.retry` は進行中の自動再試行で、`phase` は SDK の backoff 待機中 (`waiting`) か、次の assistant の応答開始後 (`retrying`)。`reason` は `auth_required` / `insufficient_quota` / `context_overflow` / `rate_limit` / `unknown` の分類コードだけで、上流のエラー原文は載らない。`run.totalRetryCount` はラン中の再試行スケジュール回数の累計（`auto_retry_start` の通知数。待機中の中止も含む）で、成功・最終失敗後も結果表示用に残る。新しいランでは 0 へ戻る。成功・最終失敗・停止でアクティブな `retry` は消える（復元時に「いつまで待機中か」を誤らないため）。

`run.errorCode` は最終失敗の分類コードで、`run.status === "error"` のときだけ載る（`error` と組になる）。停止要求と listener 例外 / `prompt()` reject が同時に起きたランは `stopped` のままで、コードを載せない。クライアントは `rate_limit` / `unknown` のときだけ再実行カードを出し、それ以外は状態行の文言だけを出す（[frontend.md](frontend.md#チャット状態とレンダリング)）。

`cwd` はワークスペース root 相対の作業ディレクトリ（プロジェクト所属は `projectCwd`、未所属は `.u7agent/sessions/<id>`）。ツール実行と `GET /api/files` の結果はこのディレクトリを起点に組み立てる。`write` / `edit` はこのディレクトリと `<root>/.agents/skills` の内側にだけ書ける（[projects.md](projects.md#write--edit-の書き込み範囲)）。`health.cwd` は root の絶対パス（表示用）で意味が違う。`projectId` は所属プロジェクト（未所属はキーを省略）。復元時は `meta.projectCwd` から `cwd` を解決し、登録が解除・消失していてもそのディレクトリを使う。

`eventGeneration` は SSE の世代（[イベント購読](#get-apisessionsidevents) を参照）。`lastSeq` と組でカーソルの整合判定に使う。

`pendingSends` は 202 で受理したが user entry としてまだ保存されていない送信（古い→新しい）。要素は `{ runId, text, at, state, position? }` で、`text` は表示用にマスク済み。`state` は `unsent`（再起動・停止・entry を残さない終了で実行されなかった）/ `queued`（待機中）/ `running`（実行中）。`position` は `queued` のときだけ載る待機中の順位（1 始まり、SSE `queued` の `position` と同じ名前で、値は `record.queue` の index + 1）。**`pendingSends` の並び（`unsentSends` の受理順）は再送で実際のキューの並びと入れ替わる**（再送は末尾へ積まれ、受理の記録は元の位置に残る）ため、順位は並びから数えず `position` を読む。クライアントは `unsent` を「未送信」へ切り替え、`queued` / `running` は受理済みの pending として保つ（別タブの再送中に表示から消さない。履歴の初回応答前でもバブルを足す）。手元にバブルが無い `unsent` は末尾へ足し、一覧から消えた未送信は別タブの再送 / 破棄として落とす（[frontend.md](frontend.md#チャット状態とレンダリング)）。再送は本文を送り直さず `POST /api/sessions/:id/messages` の `resendRunId` へ `runId` を渡す（マスク済みの本文をモデルへ送らないため）。「実行中」は `run.status === "running"` か SDK が streaming のときだけで、**終了した run は `unsent` になる**（`record.run` は終了後も status 付きで残るため、`error` で終わって user entry を残さなかった送信も再送 / 破棄できる）。旧サーバーはこのキーを載せないので、省略 = 0 件ではなく未対応として扱う（`state` があっても `position` が無いときは順位が不明として扱う）。

JSONL が破損している（SDK が追記する entry type / message role を store が知らない、途中の行が壊れている等）セッションを開く要求は 409（store のパスを含む文言）で拒否する。原本は書き換えず、一覧にも残る（[session-files.md](session-files.md#会話の保存)）。開けなかったときのクライアントの移り先は [frontend.md](frontend.md#クライアントの-effect-契約) を参照。

`messages[].at` は pi SDK が履歴に持つメッセージの作成時刻（epoch ms）。assistant は生成開始時刻で、完了時刻ではない。SDK が時刻を持たない履歴ではキーを省略する（受け手は時刻無しでも表示を壊さない）。

`messages[].usage` は SDK の `AssistantMessage.usage` をそのまま通したもの（`cost` は pi-ai の `calculateCost` 済み。料金表が無いモデルは 0）。`cacheWrite1h` / `reasoning` は報告するプロバイダだけが返す。プロバイダが usage を報告しないときはキーを省略し、0 に置き換えない（受け手は数字を出さない）。

`messages[].metrics` は BFF がイベントの到着時刻で測った応答時間。SDK は完了時刻を持たないため BFF 側でしか作れない。`durationMs` は `message_start`(assistant) から `message_end` まで、`ttftMs` は最初の text / thinking delta まで（delta が無ければ省略）、`tokensPerSecond` は `output` を最初の delta からの時間で割った値（スパンが 0 なら `durationMs`、それも 0 なら省略）。ツールループで assistant メッセージが複数あるときはメッセージごとに付く。

`ToolCall.startedAt` / `endedAt` は BFF が `tool_execution_start` / `tool_execution_end` の到着時刻で測ったツール実行の開始 / 終了（epoch ms）。`metrics` と同じく SDK は実行時刻を持たないため BFF 側でしか作れず、run を跨いで控えた値を `messages[].tools` / `run.toolCalls` / `tool_start` / `tool_end` の同じ toolCall に同じ値で載せる（クライアントは差分を実行時間として出す）。片方でも欠けたカードは実行時間を出さない（停止・中止で `tool_execution_end` が来なかったカードは `endedAt` が無い）。**この 2 つは BFF のメモリにしか無く、再起動とアイドル sweep で消える**（pi entry はツール実行の開始時刻を持たず、同じ assistant メッセージの複数ツールを `toolResult` の `timestamp` から区別できない。[persistence.md](persistence.md#会話履歴の扱い)）。

`messages[].tools` は表示対象の assistant バブルに属する確定済みツール履歴。対応する `toolResult` がある toolCall だけを `ToolCall` DTO（`done: true`）で投影し、結果が無い call は含めない。`args` / `output` はライブイベントと同じマスク・要約関数を通し、**マスクの後に**、ツール契約で値がパスと決まっている引数（`path` / `file_path` / `filePath`）だけを `./` 付きの cwd 相対へ畳む（先に畳むと cwd をまたぐ秘密値が完全一致しなくなり、後段のマスクをすり抜ける）。`command` / `output` / `path` を持たないツールの JSON 引数（本文）は畳まない: 本文の `<cwd>/…` に見える語はパスとは限らず（grep の検索語、`case` のパターン、`[ ]` の照合語）、`./…` へ書き換えるとコピーしたコマンドの挙動が変わる（表示文字列はコピーにもそのまま使う）。cwd の外は絶対のまま残し、root 相対と基準を混ぜない。`skill` はライブ専用で、スキル読み込み（`read` で basename が `SKILL.md`）はここに含めず `skillLoads` のバッジだけに出す。ask_user の `questions` / `answers` は逆に**ライブと履歴の両方で同じ `ToolCall` に載る**（`tool_start` / `tool_end` / `run.toolCalls` と `messages[].tools` が同じ値）。本文の無い assistant に属するツール履歴は同じ user ターン内の次の表示 assistant へ part 順で繰り上げるが、ターン内に表示 assistant が無い場合は復元しない（表示バブル数 / `messageCount` を維持するため。ask_user は回答待ちの間だけ resync が assistant バブルを合成する。[ask-user.md](ask-user.md#回答待ちカードの復帰)）。

`resync` は `messages[].tools` を `ToolCard` へ変換し、`toolCallId` → バブルの索引も再構築する。重複する `run.toolCalls` は現在の実行状態を優先して該当カードを更新し、履歴に無い call だけを現在ターンの最後の assistant バブルへ追加する。`messages` は有効コンテキストの投影なので、全履歴の表示は `history` API（下記）が担う。500 件の長い履歴で payload サイズと生成・JSON 化時間を検証する（`messages` に全履歴は含めない）。

### スキル読み込み（`skillLoads` / `skill`）

`messages[].skillLoads` と `run.toolCalls[].skill` は、`read` で **basename が `SKILL.md`** の呼び出し（スキル読み込み）を示す導出値。判定は server の純関数 `classifySkillRead()` 1 箇所に集約し、履歴（`projectMessages()`）とライブ（`tool_execution_start`）で共有する。専用の保存フィールドは持たず、pi entry から毎回導出する（[persistence.md](persistence.md)）。

- `name` は解決後の絶対パスの**親ディレクトリ名**（pi ネイティブと同じ）。frontmatter の `name` とは一致しないことがあり、`foo/SKILL.md` に `name: bar` があってもバッジは `[skill] foo` になる（一覧 / `/skill:` は frontmatter の `name` を使うため食い違い得る）。カタログの仮想パス（`.u7agent/agent-skills/<name>/SKILL.md`）だけはセグメントが percent encoding 済みなので、デコードした元の名前をバッジの名前として出す（`location` / `path` は `read` に渡す encoded のまま）。`path` は解決後の絶対パス（pi の展開表示は cwd 相対だが、ライブ / 履歴で同じ値にするため絶対で統一する）。`offset` / `limit` は `read` の引数をそのまま持つ
- cwd は絶対 session cwd（`workspaceAbs(rootCwd, record.workdir)`）に統一する。対応する path は絶対 / 相対 / `.` / `..` のみで、`~` 展開・`@` 接頭辞・`file://`・Unicode スペース正規化は非対応（該当しない）。組み込みの仮想パス（`.u7agent/builtin-skills/<name>/SKILL.md`）も同じ規則で成立する（厳密な name 照合はしない）
- `skillLoads` は「**このバブルに出す分**（繰り上げ分を含む）」。`isDisplayableMessage()` は本文を要求するため、`read` だけの assistant メッセージは表示集合から落ち、**同じ user ターン内の次の表示可能な assistant メッセージへ繰り上げる**（メッセージ順 → part 順、繰り上げ分が先）。次の user メッセージは越えず、ターン内に表示可能なメッセージが無ければ落とす（既知の制限）。繰り上げても `messages` の件数と `messageCount` は変えない
- `isError` は省略可能で、省略 = ロード扱い。履歴は `toolResult` を `toolCallId` で join して `isError: true` のときだけ載せる。`toolResult` が無い read は、その read を含む assistant メッセージの `stopReason === "aborted"` なら発火扱いにしない（abort で一度も実行されていない）。それ以外の欠落（crash / restart・compaction 境界）は実行済みとしてロード扱いにする
- ライブの `ToolCall.skill` は `tool_execution_start` の時点で結果が無いため `isError` を載せない（バッジのエラー表示はカードの位相が担う）。実行済みで表示メッセージに載る read に限り、ライブの `ToolCall.skill` と履歴の `skillLoads[]` は同じ値（`id` / `name` / `path` / `offset` / `limit`）になる
- `name` / `path` は他の文字列と同じく、分類（basename 判定）の後にマスクしてから配る（[secrets.md](secrets.md)）
- abort で未実行の read はライブでは `tool_end` が来ずカードが `running` のまま残る（履歴側は発火扱いにしないため差異が残る。既知の制限）

`context` は SDK の `getContextUsage()`（`tokens` / `contextWindow` / `percent`）。compaction 直後は `tokens` と `percent` が `null` になる。SDK がこの API を持たないときはキーを省略する。SDK は `message_end` を購読者へ配った後に履歴へ入れるため、`usage` イベント時点の `context` は直前の応答までの値（compaction 直後は不明値）になる。今回の応答を反映した確定値は `run_end` の `context` で配り、リロード / resync はこの payload を正とする。セッションが未作成のとき（チャット開始前）は `context` のキー自体が無く、UI は Context ゲージを出さない。作成済み・未送信のセッションは SDK が `tokens: 0` / `percent: 0` を返すため 0% として出る。

`compactions` は会話の圧縮（compaction）の履歴を古い→新しいの順で持つ（圧縮が無ければ `[]`）。要素は pi SDK の `CompactionEntry` をそのまま写せる形（`id` / `parentId` / `timestamp` / `summary` / `firstKeptEntryId` / `tokensBefore` / `usage` / `fromHook`）で、表示用の文字列へ潰さずアプリ独自の連番 ID も振らない（`id` は SDK entry の id で、永続化後も一意に参照できる）。

- `summary` は他の出力と同じく、既知の秘密値を `[REDACTED]` に置き換えてから配る。SDK 側の entry は書き換えない
- `beforeMessageIndex` は区切りを置く `messages` の index（この index の手前。`messages.length` なら末尾）で、**最新の 1 件だけ**が持つ。位置は `messages` と同じ集合を数えて求め（entry は「compaction より手前か」の判定だけに使う）、SDK が context を組み替えても `messages` とずれない。SDK は最新の compaction しか context に残さないため、以前の圧縮位置は `messages` から復元できない。回数は `compactions.length` で示し、過去分は要約の一覧として読む
- `reason`（`manual` / `threshold` / `overflow`）と `estimatedTokensAfter` は `CompactionEntry` に保存されず `compaction_end` にしか無いため、BFF がイベント受信時に entry id ごとに控えて payload 組み立て時に合成する。控えは揮発で、BFF の再起動後はキーを省略する（`reason` が無くても `tokensBefore` だけで表示は成立する）
- `durationMs` は `compaction_start` から `compaction_end` の到着までを BFF が測った圧縮時間（手動 / 自動の両方）で、`reason` と同じ控えから合成する。失敗・中止のときは `compaction_end` を記録しないため載らない（区切りごと出さない現行の挙動を変えない）。表示は [compaction.md](compaction.md#表示仕様) を正とする
- `tokensBefore` は最後の assistant の usage と末尾メッセージの推定を足した SDK の `estimateContextTokens()` の値で、プロバイダの実測そのものではない。`estimatedTokensAfter` は `estimateMessagesTokens()` の推定値で、初期 UI には出さない（Context ゲージは provider 実測のため、並べると食い違いに見える）
- 圧縮で context から外れたメッセージは `messages` から消える（`messages` は有効コンテキストの投影）。圧縮前の元メッセージは `history` API で全履歴として読める。`messages` に role `compactionSummary` のメッセージは載せない

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
- `prevCursor` はページ先頭 item の直前にある item の id（無ければ `null`）。クライアントはこれでページ間の連続性を判定し、保持分と繋がらない（別タブで `limit` 以上追記された / 分岐が変わった）ときは欠落区間を `before` で取り直し、1 ページに収まらなければ最新ページで組み直す
- 存在しないカーソルは空の成功へ縮退させず 400（`{ "error": "Unknown history cursor" }`）。存在しないセッションは 404
- item の `id` は SDK entry の id（id を持たない旧履歴だけ `legacy-<entry index>`）。`context` は `active`（現在も生の context にある）/ `summarized`（最新の compaction の `firstKeptEntryId` より手前）/ `excluded`（`context_edit` で外れた）で、判定は [compaction.md](compaction.md#全履歴の表示閲覧と段階読み込み) を正とする
- user item には、その発言を送信した run の `runId` が載る（送信応答 `POST /api/sessions/:id/messages` の `runId` と同じ値）。実行時の対応表（SDK メッセージ → run id）を先に引き、再起動後は JSONL の entry に写した注記（`u7agentRunId`。[session-files.md](session-files.md#sendsjson-と-run-id-の注記)）から復元する。クライアントはこの値で自分の送信エコーを他クライアントの同一文面 item と区別し、`run_start` やページ適用で正しい item へ吸収する。対応が無い旧保存データの item だけが、文書化済みの本文正規形（+ 送信時点の位置 `since`）での縮退対象になる（[frontend.md](frontend.md)）。未送信（下記）の item は存在しないため、同一文面の item が別 run で載っていても吸収されない
- user item には、そのターンの `runDurationMs` / `runOutcome` も載る。値は `run_end` と同じ定義（キュー待ちを含めず、`run_end.status` を終端の `completed` / `stopped` / `error` へ絞ったもの）で、ターン終端の行の表示に使う。控えは揮発なので BFF の再起動 / アイドル sweep の後は両方とも載らず、クライアントは行ごと出さない（[run-lifecycle.md](run-lifecycle.md#状態)）。
- キュー待ちの送信にも受け付けた時点で `runId` を振り、応答と、そのメッセージから始まる run の `run_start` で同じ値を使う（旧サーバーは実行中の run の id を返していた）
- `firstKeptEntryId` は metadata entry を指し得る。その場合も「その entry 以降が有効」として位置だけを使い、メッセージ検索で境界をずらさない
- `messageCount` / `summarizedMessageCount` はページではなく現行ブランチ全体の値。クライアントは保持済みの古いページの `summarized` を更新するのに使う（この 2 つだけがページ外の全体量を表す）
- `activeContextStartId` は現在有効なコンテキストの先頭 message item。要約で置き換わった範囲が無いときは `null`
- 本文 / 要約 / ツール出力は他の経路と同じマスカーを通す（[secrets.md](secrets.md)）。JSONL の保存形式は変えない
- 投影はページ範囲を選んでからその範囲にだけ掛ける（全エントリーを DTO 化してから切らない）

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
- 改名した会話は、以降のメッセージから自動タイトルを作り直さない（自動タイトルは `title` が空のときだけ最初のメッセージで作る。[session-files.md](session-files.md#metajson)）。
- 保存に失敗したら 500 を返し、成功扱いにしない（in-memory の表示は新しい値のまま）。
- 一覧とチャットのヘッダは一覧 API を正とするため、クライアントは応答の `title` を手元の一覧へ反映する（他タブは一覧のポーリングで追随する。notify と同じ）。

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

## `POST /api/sessions/:id/messages`

メッセージ送信。**202 で即時返却**し、ランは裏で続く。実行中に呼ぶとキューに積まれる（最大 10 件、超過は 429）。

```json
// request
{ "text": "README を読んで改善案を 3 つ" }
// request (添付あり)
{ "text": "これを見て", "attachments": [".u7agent/uploads/a1b2c3d4e5/photo-1.png", ".u7agent/uploads/a1b2c3d4e5/report.pdf"] }
// request (未送信メッセージの再送。text は載せない)
{ "resendRunId": "…" }
// response (202)
{ "sessionId": "…", "status": "running", "queued": false, "queueDepth": 0, "runId": "…" }
```

- `attachments` は root 相対のパスで、そのセッションの保存先 `<appdir>/uploads/<sessionId>/` 配下だけを許可する（`./` は正規化、`..`・絶対パス・ディレクトリ自体・別セッションの保存先は 400）。最大 10 件、文字列以外は 400。
- `text` は空でも添付があれば送れる（本文も添付も無いときだけ 400）。
- `resendRunId` は payload の `pendingSends` の `runId` を指定する。本文はストアに保存済みの生テキストを使い、同じ run id で実行し直す（表示用のマスク済み本文を送り直さない）。実行中 / キュー待ちの run への二重の再送は重ねず、現在の状態を返す。記録が無い（保存済み / 破棄済み）run id は 409。受理の記録はそのままで、user entry が保存された時点で未送信から外れる。受付後は `resync` を 1 件配り、別タブの未送信表示を更新する（キュー受付の `queued` は run id を載せないため）
- `text` が `/skill:` で始まるときは、BFF が本文ブロックへ展開してから送る（[`/skill:` の展開](#skill-の展開)）。
- BFF は本文の末尾に注記を合成してから `SessionStore.postMessage` へ渡す（[注記](#添付の注記)）。
- 圧縮中に送るとキューに積まれ、`queued: true` と `queueDepth` を返す（受け付けた時点で `runId` を振る）。圧縮の終端処理の後に 1 回だけ pump し、同じ 202 の応答で次のランが始まる（排他の判定は BFF の `compacting` フラグ。SDK は保存待ちの間 idle に見える）。
- 受理した送信は user entry が保存されるまで `sends.json` の `unsent` に残る（[session-files.md](session-files.md#sendsjson-と-run-id-の注記)）。サーバー再起動でキューごと消えた分は payload の `pendingSends` に載り、クライアントは「未送信」として見せる（[frontend.md](frontend.md#チャット状態とレンダリング)）。

### `DELETE /api/sessions/:id/unsent/:runId`

未送信メッセージを破棄する（再送せず表示からも消す）。

- 成功は `{ "ok": true }`。記録が無い（別タブで再送 / 破棄済み）は 404、再送が実行中 / キュー待ちの run id は 409（実行中の送信を消さない）。成功時は `resync` を 1 件配り、別タブの未送信表示を消す
- 本文はストアから消える。再送（POST /messages）は記録を残したまま実行するため、破棄だけが本文を捨てる経路になる

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

- 形式は SDK の `_expandSkillCommand` と同じ（`parseSkillBlock` で読み直せる）。`location` は `read` に渡す値と同じで、ファイル / 組み込み / カタログとも絶対パス（組み込みは `<root>/.u7agent/builtin-skills/...`、カタログは `<root>/.u7agent/agent-skills/...` の仮想パス）。カタログは実体が無いので「References are relative to …」行は入らない。引数はブロックの後に空行を挟んでそのまま渡す
- 本文の取得元はスコープ別: ファイル（共通 / プロジェクト）→ サンドボックスの `GET /v1/files/preview`、組み込み → BFF の registry、カタログ（Agent 割り当て）→ セッションの `promptSnapshot`（旧 `<skill>` と新 `<agent_skill>` の両方を受け付け、タグではなく `name` 属性で引く）
- 名前は優先順位 `プロジェクト > 共通 > 組み込み > カタログ` で一意に解決する（[一覧 API](#get-apisessionsidskills) と同じ解決を共有）。未知の名前、`/skill:` で始まらない本文は素通しする（SDK と同じ挙動）
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
- クライアントは注記を分解し、user バブルにチップと本文を分けて表示する（コピーも注記を除いた本文が対象）。ローカルエコーは素の本文で先に出し、送信応答の `runId` が付いた後（`echoRunId`）に `run_start` の注記込み本文へ差し替える。`run_start` が応答より先でも本文は控えておくため、別 run (別タブ) の本文では差し替えない（`client/src/hooks/chatReducer.ts`。run id が無い旧経路だけ送信順の待ち行列と本文の正規形で突き合わせる）

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

- `scope` は `project` / `user`（共通）/ `builtin` / `catalog`（エージェント定義のスキル）。並びは優先順位 `project > user > builtin > catalog`
- `cwd` はセッションの作業ディレクトリ（root 相対）。`projectSkills` はプロジェクトスキルを探索するセッションか（未所属のスクラッチと root 直下は `false`）
- `location` は `read` に渡す値（カタログは実体の無い仮想パス `.u7agent/agent-skills/<name>/SKILL.md`）。カタログのセグメントは percent encoding 済みで、表示用の `relativePath` は元の名前に戻して見せる。`relativePath` は root の外のみ `null`
- 同名は優先順位で一意化する。負けた行（組み込みの上書きとカタログ）は `shadowed: true` と `shadowedBy`（優先される側の `location`）で示し、採用された行は `shadows`（隠している側の `location`）を持つ。`shadows` に入るのは**ファイルスキル同士の重複**で、カタログは常に敗者側にしか立たない。**ファイルの改名・削除・マージはしない**
- カタログの `description` はセッションのエージェントスナップショット（`agent.skills`）から、本文は `promptSnapshot` から引く。どちらも作成時点の内容で、定義を編集してもこのセッションの一覧は変わらない。同じスナップショットを `skillsOverride` の索引と `read` の横取りにも使い、system prompt には本文を載せない（[api-catalog.md](api-catalog.md#セッションへの渡し方)）
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
- 解決に渡すのは `relativeCwd = project.cwd ?? ""`、`promptSnapshot = composePromptSnapshot(agent, skills)`、`agentSkills = agentInfo.skills`。エージェントの解決（`skillIds` → スキル + スナップショット）はセッション作成と同じヘルパーを使い、client へ二重実装しない
- プロジェクトを指定したときは、作成と同じ条件（永続化あり）で登録ディレクトリの存在を確かめ、無ければ 400（`server/src/sessions.ts` の `requireProjectDir` を共有）。サンドボックス未設定は 503 で、組み込み / カタログだけへは縮退させない（その一覧から選んだ `/skill:` も `createSession` の 503 で送れないため）
- 探索の失敗の扱いは `GET /api/sessions/:id/skills` と同じ（置き場が無い 404 は空、サンドボックス由来はその status、`SandboxRequestError` 以外は 500）
- 内容は作成前の選択で解決した**現在の**定義とファイルになる。カタログの説明・本文は作成時にスナップショットされるため、プレビューから送信までの間に定義を編集するとセッションの一覧とずれ得る（許容する）。ファイルスキルはどちらも一覧のたびに探索し直す
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

- `path` は root 相対。サンドボックスも root 相対を返すため、BFF はそのセッションの保存先（`<appdir>/uploads/<sessionId>/`）に解決できることを確かめてそのまま返す（外を指す・`..` を含む・別セッションの応答は契約違反として 502）。raw 表示 URL はこの値をそのまま `GET /api/files/raw` の `path` に使う
- 保存先は所属に関係なく `<appdir>/uploads/<sessionId>/`。同名ファイルは上書きせず `name-1.ext` 形式で連番にする（詳細は [session-files.md](session-files.md#添付ファイルチャットからのアップロード)）
- 400（`name` が不正）/ 404（セッションなし）/ 413（100 MiB 超。`Content-Length` で分かるときは本文を送らずに返す）/ 503（サンドボックス未設定）/ 502（サンドボックスへ到達できない・応答が契約外）
- 上限は 1 ファイル 100 MiB、ファイル名 200 文字（いずれも最終判定はサンドボックス側）

## `GET /api/sessions/:id/events`

SSE（`text/event-stream`）でイベントを購読。カーソルは `Last-Event-ID` ヘッダ（`<generation>:<seq>`）→ query の `generation` + `after` → `resync` の優先順位で解決する。世代（payload の `eventGeneration`）が現在と一致し、seq がバッファ範囲内のときだけ差分をリプレイし、それ以外は `resync`（セッション全体のペイロード）を 1 件送る。再起動や sweep の復元で seq が 0 に戻っても、古いタブは 1 回の resync で整合する。

接続直後と、以降 15 秒ごとに `ping`（可視イベント）を送る。`id` を付けないため `Last-Event-ID` は動かない。クライアントはこれを生存確認にだけ使い、状態には流さない（dev の Vite プロキシは upstream が落ちても接続を閉じないので、無音を切断とみなして張り直す）。

バッファからのリプレイ範囲に待機中の `run_retry` を含むときは、リプレイの末尾に現在のペイロードを持つ `resync` を 1 件続けて送る。リプレイされたイベントの `serverNow` は発行時点のままで、クライアントが受信時刻を起点にすると残り時間が過大になるため（`retryAt` は絶対値、判定は [run-lifecycle.md](run-lifecycle.md#再試行状態の配信と復元)）。

イベントタイプ:

| イベント | data |
| --- | --- |
| `run_start` | `{ runId, prompt, startedAt }`（`startedAt` は payload の `run.startedAt` と同じ値） |
| `text` | `{ delta }` |
| `tool_start` / `tool_end` | `{ id, name, args, skill?, questions?, startedAt? }` / `{ id, name, isError, output, answers?, endedAt? }`（`skill` は `run.toolCalls[].skill` と同じスキル読み込み。結果が無い時点なので `isError` は載らない。`questions` / `answers` は ask_user のときだけ載り、`run.toolCalls` と `messages[].tools` と同じ値。`startedAt` / `endedAt` は BFF 計測のツール実行の開始 / 終了で、`run.toolCalls` / `messages[].tools` と同じ値。旧サーバーは載せない） |
| `tool_progress` | `{ id, text }`（`investigate` の子の進捗。`id` は `tool_start` / `tool_end` と同じ toolCallId で、ライブの `ToolCall.progress` だけを更新する。payload には載らない live 専用） |
| `status` | `{ state, text }`（`thinking` / `tool` / `question`（回答待ち）/ `compacting` / `retry` / `warning` / など。手動圧縮の終端では成功 / 失敗の文言を配る。自動再試行の文言は `run_retry` の構造化情報からクライアントが導出する） |
| `queued` | `{ position, queueDepth, prompt }` |
| `queue_cleared` | `{ runIds? }`（停止で破棄した待機メッセージの run id。クライアントは該当する送信を「未送信」へ切り替える。旧サーバーは載せない） |
| `run_retry` | `{ retry, totalRetryCount, serverNow }`（自動再試行の開始 / 再実行開始 / 解除。`retry` は payload の `run.retry` と同じ形で、解除時は `null`） |
| `run_end` | `{ runId, status, durationMs?, error, errorCode?, messageCount, queueDepth, totalRetryCount?, context? }`（`messageCount` は一覧 API と同じ表示メッセージ数。`durationMs` は BFF 計測のラン全体の所要時間で、キュー待ちは含めず `startRun()` から `finish()` までを測る。完了 / 停止 / エラーのいずれでも載り、クライアントは状態行に「完了（1m 12s）」のように凍結表示し、同じ値と `status` をその run の user パブルへ写してターン終端の行（`Complete · 1m 20s`）に残す（履歴経路は `history` の `runDurationMs` / `runOutcome` が正）。`errorCode` は `status === "error"` のときだけ載る最終失敗の分類コードで、`error` と組になる） |
| `usage` | `{ usage?, metrics?, context? }`（assistant の `message_end` ごとに 1 件。usage はプロバイダが報告したときだけ、metrics は BFF 計測、context は SDK の `getContextUsage()` だが履歴反映前なので確定値は `run_end` 側） |
| `compaction` | `{ compaction, count }`（`compaction_end` ごとに 1 件。`compaction` は payload の `compactions` の要素 1 つ、`count` はその時点の累計回数。run の自動圧縮では続けて同じ状態を持つ `resync` が届く（送信メッセージを履歴へ入れる前に圧縮が走った場合は、そのメッセージが入ってから届く）。手動圧縮では resync を配らず、保存の完了後に終端 `resync` が 1 回届く。`result` が無い / `aborted` / `errorMessage` ありのときは `compaction` も `resync` も配らない） |
| `resync` | セッションペイロード全体（バッファを逃した場合・世代が一致しない場合と、手動圧縮の開始 / 終端） |
| `session_deleted` | `{ sessionId }`（削除時。送出後に接続を閉じる） |
| `ping` | `{}`（接続直後と 15 秒ごとの生存確認。`id` 無し = カーソルを動かさない） |

テキスト系イベント（`text` / `tool_start` / `tool_end` / `tool_progress` / `run_start` / `queued` / `run_end` のエラーや `resync` の `messages`・`compactions[].summary`、`compaction` の `compaction.summary` など）は、既知のプロバイダーAPIキーの値が `[REDACTED]` に置換されて配信される。対象キーと保証範囲は [secrets.md](secrets.md) を参照。

### 失敗試行の取り消しとエラーの公開契約

- 再試行対象になった失敗 assistant の途中テキストは、SDK が `context_edit` を追加して投影を更新した後に届く `resync` で表示から取り消す（`resync.messages` が正）。失敗試行と次の試行のテキストは連結しない。確定済みのツール履歴・先行する正常な assistant は残る。
- `run_end.error` / `payload.run.error` / `resync` のエラーは、共通の分類（恒久的な利用枠 → 認証 → コンテキスト超過 → `rate_limit` → `unknown`）を通した定型日本語だけを配る。プロバイダーの生エラー（組織ID・APIキーを含み得る）は公開経路へ出さない。最終失敗の文言には再試行のスケジュール累計と原因別の操作案内を含める。
- `run_end.errorCode` / `payload.run.errorCode` は同じ分類コードで、`status === "error"` のときだけ載る（停止要求と例外が同時に起きたときは `stopped` を正とする）。分類コードは `run.error` の再実装ではなく、クライアントが再実行カードを出すかの判断にだけ使う。
- 分類・文言の定義と SDK イベントの対応は [run-lifecycle.md](run-lifecycle.md#自動再試行sdk-の-retry) / [run-lifecycle.md](run-lifecycle.md#失敗の分類と公開契約) を正とする。

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

セッションを削除する。停止 + 会話ストアの履歴削除を行い、購読中の SSE には `session_deleted` が通知される。作業ディレクトリ（プロジェクト所属は登録ディレクトリ、未所属は `.u7agent/sessions/<id>`）と添付（`.u7agent/uploads/<id>`）は残る。未ロードのセッションは SDK セッションを開かずに消せる（モデル未認証・JSONL 破損でも削除できる）。未知の id は 404。
