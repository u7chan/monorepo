# セッション API

規約と索引は [api.md](api.md) を参照する。設計の背景は [run-lifecycle.md](run-lifecycle.md)、compaction は [compaction.md](compaction.md)、Model / Effort は [model-effort.md](model-effort.md) を正とする。

## スペース文脈

作成の本文以外は、全会話 API（SSE・添付も含む）へ `?spaceId=<id>` を渡す。省略は既定の `default`。所属不一致は SDK 復元や変更の前に 404 とする（[api.md](api.md#スペース)）。一覧は要求スペースだけを返し、未指定一覧に追加スペースを混ぜない。`SessionSummary` / `SessionPayload` は正規化した `spaceId` を返す。

`POST /api/sessions` の optional `spaceId` は本文で指定する。所属を後から変えるのは `POST /api/sessions/:id/move` だけで、履歴を破棄して作業フォルダ / 添付を移動先へ物理移動する（同 API の節を参照）。追加スペースと `projectId` の併用は 400。追加スペースの cwd は `.u7agent/spaces/<spaceId>/sessions/<sessionId>`、添付は同階層の `uploads/<sessionId>` とし、その会話の添付だけを送信時に許容する。既定の cwd・添付・既存参照は変えない。未確定会話の `GET /api/skills/session` も query の所属を確認し、追加スペースでは `projectId` を拒否する。

## `GET /api/sessions`

セッション一覧（最終使用の新しい順）。query の `spaceId`（既定 `default`）で絞り、`scope=all` のときは全スペースを返す（`spaceId` は無視する。実行状況のダッシュボードが使う）。

```json
{
  "sessions": [
    {
      "sessionId": "…",
      "title": "README をレビューして",
      "agentId": "agent-general",
      "agentName": "汎用アシスタント",
      "status": "running",
      "awaitingAnswer": true,
      "queueDepth": 0,
      "pinned": false,
      "canMove": true,
      "hasRawLog": true,
      "messageCount": 4,
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000001000,
      "serveCommand": { "cwd": "projects/foo", "command": "python3 -m http.server 8080" },
      "model": "<provider>/<id>",
      "projectId": "…",
      "runStartedAt": 1700000000500,
      "finishedAt": 1700000009000,
      "lastRunDurationMs": 8400,
      "compactionStartedAt": 1700000010000,
      "awaitingSince": 1700000003000
    }
  ]
}
```

`runStartedAt` / `finishedAt` は live な実行の開始・終了、`compactionStartedAt` は圧縮の開始、`awaitingSince` は未 settle の質問のうち最も古い開始時刻、`lastRunDurationMs` は直近のランの所要時間（`runOutcomes` にあるときだけ）で、どれも該当が無ければキーを省略する。未ロードの会話は `idle` でこれらの時刻を載せない（`lastUsedAt` を開始時刻の代用にしない）。終了済みの live レコードは終了から 120 分の間だけ sweep の対象外になる。

`pinned` はサイドバーで固定するかを示す（常に boolean）。`awaitingAnswer` は `ask_user` の未 settle の回答待ちがあるか（省略 = false）。この間もランは `running` のままで、左バーの行が「回答待ち」になる（[ask-user.md](ask-user.md#ui)）。待機を持たない未ロードの会話は省略し、ロード済みの会話は待機が無くても `false` を返す。`canHandoff` は同じ会話のままエージェント / スペースを引き継げるか（常に true。旧サーバーは省略 = false）。`projectSession` はプロジェクト所属か（真では引き継ぎ先のスペースを選ばない）。`handoffCleanup` は確定後の履歴削除（片付け）が残っているか（省略 = false。真の間は開く要求が 409 になり、新しい引き継ぎも受け付けない）。`hasRawLog` は生ログ（`session.jsonl`）がディスクにあるか（省略 = false）。設定 → ランタイム の診断タブは、まだ診断応答を取れていないときの出し分けにこの値を使い、応答が取れていれば `raw.available` を正とする。false のときだけダウンロードを押せなくし、理由を 1 行で出す（[diagnostics.md](diagnostics.md#取れないもの)）。`projectId` は所属プロジェクト（未所属はキーを省略する）。所属は保存された `projectCwd` をプロジェクト一覧と突き合わせて読み取り時に解決するため、プロジェクトを解除すると配下セッションは未所属として返る（セッションと履歴・ピン状態は残る）。復元したセッションも同じ規則で解決する。

`serveCommand` はその会話の作業ディレクトリ（workdir）の serve 成功実績で、`{ cwd, command }` か **無ければ `null`**（キーは常に載る）。cwd を共有するプロジェクト会話は同じ値を返し、別ディレクトリの実績は返さない。実行状況（`/activity`）はこれを終了行に起動の操作を出す条件と、起動の確認に出す作業ディレクトリ・コマンドに使う（[frontend.md](frontend.md#全スペースの一覧)）。

`messageCount` は表示メッセージ数（`user` と、テキストを持つ `assistant`。ツール呼び出しだけのターンは数えない）で、履歴の生件数ではない。未ロードのセッションは保存された `meta.json` の値、ロード済みは現在の履歴から数えた値を返す（ずれの扱いは [session-files.md](session-files.md)）。

## `POST /api/sessions`

セッション作成。body は任意。

```json
{ "agentId": "agent-general", "model": { "provider": "<provider>", "id": "<id>" }, "thinkingLevel": "high", "projectId": "…" }
```

- `agentId` は optional。省略するとビルトインの汎用アシスタント（`agent-general`）を使うので、ユーザー定義が 0 件でも作成できる（[api-catalog.md](api-catalog.md#ビルトインの汎用エージェント)）。未知の id は 400。
- `model` / `thinkingLevel` はそれぞれ optional（`null` は 400）。省略した項目は「エージェント定義 → アプリ既定」の順に解決する。アプリ既定が未設定（`health.defaultModelUnset`）の間はモデルを指定しない作成が 503 になる（候補の先頭では代用しない）。
- `projectId` は optional。省略したセッションは未所属になる。未知の `projectId` は 400（未所属へは落とさない）。
- セッションの作業ディレクトリは、所属プロジェクトがあれば登録ディレクトリ（`project.cwd`）、未所属なら所属スペースのスクラッチ（既定スペースは `.u7agent/sessions/<id>`。置き場は [session-files.md](session-files.md#スペースごとの配置)）。以降のツール実行とファイル一覧の起点になり、`write` / `edit` の書き込み範囲でもある（共通スキル置き場 `<root>/.agents/skills` は別枠。 [projects.md](projects.md#write--edit-の書き込み範囲)）。プロジェクトのディレクトリは作らず存在確認だけを行い、無ければ 400。未所属のスクラッチは作成時にサンドボックスの `POST /v1/dirs` で作る。会話の永続化が有効なときは `meta.json` / `session.jsonl` も同じ id で会話ストアへ作る（[session-files.md](session-files.md)）。所属を後から変える API は無い。詳細は [projects.md](projects.md#セッション-cwd)。
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
    { "sendId": "…", "text": "送信が保存されなかった本文", "at": 1700000000000, "state": "unsent" },
    { "sendId": "…", "text": "SDK が取り出した本文", "at": 1700000000001, "state": "steering", "position": 1 },
    { "sendId": "…", "runId": "…", "text": "実行中の本文", "at": 1700000000002, "state": "running" }
  ]
}
```

`model` / `thinkingLevel` は pi SDK のセッションが持つ実効値（`thinkingLevel` は SDK 補正後）。`supportsThinking` と `availableThinkingLevels` はその実効モデルの能力を SDK の公開ヘルパーから引いたもの。`agent` は作成時点のスナップショット（スキル許可リストと `toolNames` を含む）なので、定義を編集・削除しても既存チャットの表示とツールの実効は変わらない。

`status` は `idle` / `running` / `queued` / `compacting` / `completed` / `stopped` / `error`。`compacting` は手動圧縮の実行中で、SDK の実行中だけでなく**保存待ち**も含む（排他の正は BFF のフラグ。詳細は [compaction.md](compaction.md#手動圧縮)）。`compactionStartedAt` はその開始時刻（epoch ms）で、`status` が `compacting` のときだけ載る（終端の `resync` では載せない）。経過時間の起点はこの値を使い、`run.startedAt` は再利用しない。

`serverNow` は payload を組み立てたサーバー基準時刻（epoch ms）。`run.retry.retryAt` との差でクライアントが待機の残り時間を出すための値で、ブラウザの時計と直接比較してはならない（リロード / SSE 再接続 / 別タブでも同じ残り時間を復元する。詳細は [run-lifecycle.md](run-lifecycle.md#再試行状態の配信と復元)）。

`run.retry` は進行中の自動再試行で、`phase` は SDK の backoff 待機中 (`waiting`) か、次の assistant の応答開始後 (`retrying`)。`reason` は `auth_required` / `insufficient_quota` / `context_overflow` / `rate_limit` / `unknown` の分類コードだけで、上流のエラー原文は載らない。`run.totalRetryCount` はラン中の再試行スケジュール回数の累計（`auto_retry_start` の通知数。待機中の中止も含む）で、成功・最終失敗後も結果表示用に残る。新しいランでは 0 へ戻る。成功・最終失敗・停止でアクティブな `retry` は消える（復元時に「いつまで待機中か」を誤らないため）。

`run.errorCode` は最終失敗の分類コードで、`run.status === "error"` のときだけ載る（`error` と組になる）。停止要求と listener 例外 / `prompt()` reject が同時に起きたランは `stopped` のままで、コードを載せない。クライアントは `rate_limit` / `unknown` のときだけ再実行カードを出し、それ以外は状態行の文言だけを出す（[frontend.md](frontend.md#チャット状態とレンダリング)）。

`cwd` はワークスペース root 相対の作業ディレクトリ（プロジェクト所属は `projectCwd`、未所属は所属スペースのスクラッチ。置き場は [session-files.md](session-files.md#スペースごとの配置)）。ツール実行と `GET /api/files` の結果はこのディレクトリを起点に組み立てる。`write` / `edit` はこのディレクトリと `<root>/.agents/skills` の内側にだけ書ける（[projects.md](projects.md#write--edit-の書き込み範囲)）。`health.cwd` は root の絶対パス（表示用）で意味が違う。`projectId` は所属プロジェクト（未所属はキーを省略）。復元時は `meta.projectCwd` から `cwd` を解決し、登録が解除・消失していてもそのディレクトリを使う。

`eventGeneration` は SSE の世代（[イベント購読](#get-apisessionsidevents) を参照）。`lastSeq` と組でカーソルの整合判定に使う。

`pendingSends` は 202 で受理したが user entry としてまだ保存されていない送信（古い→新しい）。要素は `{ sendId, runId?, text, at, state, position? }` で、`text` は表示用にマスク済み、`runId` は実行へ割り当て済みのときだけ載る（手動圧縮待ちなど未割当の送信では省略する）。`state` は `unsent`（未送信）/ `queued`（配送待ち。取消できる）/ `steering`（SDK が取り出して反映中。取消・再送・破棄は不可）/ `running`（実行中）で、`queued` と `steering` の境目は SDK の実キューから取り出されたかどうか。判定は `server/src/schema.ts` の `PendingSendSchema` と `server/src/session-steering.ts` / `server/src/session-payload.ts` を正とする。`position` は **BFF の配送キューの並び**（SDK へ渡した分も含む）の index + 1 で、`queueDepth` も同じ集合を数える（上限も同じ件数で判定する）。送信の照合・取消・再送・破棄はすべて `sendId` で行い、`runId` は実行への所属だけを表す。

`pendingSends` の並び（受理順）は再送で実際のキューの並びと入れ替わる（再送は末尾へ積まれ、受理の記録は元の位置に残る）ため、順位は並びから数えず `position` を読む。クライアントは未保存の送信を「未送信」へ切り替え、配送に残る送信は受理済みの pending として保つ（別タブの再送中に表示から消さない。履歴の初回応答前でもバブルを足す）。手元にバブルが無い未送信は末尾へ足し、一覧から消えた未送信は別タブの再送 / 破棄として落とす（[frontend.md](frontend.md#チャット状態とレンダリング)）。再送は本文を送り直さず `POST /api/sessions/:id/messages` の `resendSendId` へ `sendId` を渡す（マスク済みの本文をモデルへ送らないため）。「実行中」は `run.status === "running"` か SDK が streaming のときだけで、**終了した実行の送信は配送対象から外れて `unsent` になる**（`error` で終わって user entry を残さなかった送信も再送 / 破棄できる）。旧サーバーはこのキーを載せないので、省略 = 0 件ではなく未対応として扱う（`state` があっても `position` が無いときは順位が不明として扱う）。

`handoff` は直前の引き継ぎの状態（`{ operationId, at, memo, consumed, cleanupPending }`）。`operationId` は引き継ぎごとのランダムな 8 hex、`memo` は `HANDOFF.md` を書いたか、`consumed` は引き継ぎ後に最初の送信を受理済みか（未送信の破棄では戻らない）、`cleanupPending` は片付けが残っているか。チップ「HANDOFF.mdを参照」は `memo && !consumed` のときだけ出す（表示はクライアントのメモリではなくこの値から導出する。 [ui-layout.md](ui-layout.md#スペース)）。引き継ぎを受けていない会話と旧サーバーはキーを省略する。

JSONL が破損している（SDK が追記する entry type / message role を store が知らない、途中の行が壊れている等）セッションを開く要求は 409（store のパスを含む文言）で拒否する。原本は書き換えず、一覧にも残る（[session-files.md](session-files.md#会話の保存)）。開けなかったときのクライアントの移り先は [frontend.md](frontend.md#クライアントの-effect-契約) を参照。

`messages[].assistantId` は BFF が実行内で割り当てた assistant 応答ID（`<runId>:<seq>`）。同じ応答の `text` / `tool_start` / `assistant_end` と、保存済み entry / 履歴 item が同じ値を持つ。旧保存データではキーを省略する。

`messages[].at` は pi SDK が履歴に持つメッセージの作成時刻（epoch ms）。assistant は生成開始時刻で、完了時刻ではない。SDK が時刻を持たない履歴ではキーを省略する（受け手は時刻無しでも表示を壊さない）。

`messages[].usage` は SDK の `AssistantMessage.usage` をそのまま通したもの（`cost` は pi-ai の `calculateCost` 済み。料金表が無いモデルは 0）。`cacheWrite1h` / `reasoning` は報告するプロバイダだけが返す。プロバイダが usage を報告しないときはキーを省略し、0 に置き換えない（受け手は数字を出さない）。

`messages[].metrics` は BFF がイベントの到着時刻で測った応答時間。SDK は完了時刻を持たないため BFF 側でしか作れない。`durationMs` は `message_start`(assistant) から `message_end` まで、`ttftMs` は最初の text / thinking delta まで（delta が無ければ省略）、`tokensPerSecond` は `output` を最初の delta からの時間で割った値（スパンが 0 なら `durationMs`、それも 0 なら省略）。ツールループで assistant メッセージが複数あるときはメッセージごとに付く。

`assistantMeta` は `messages` に現れない assistant 応答の `{ assistantId, at?, usage?, metrics? }`（配列）。表示 item にならない応答（本文が無く、確定したツールカードも持たない応答）でも、未回答の ask_user カードは復帰のために assistant バブルを合成するため、元の応答の時刻と応答時間を `assistantId` で引き当てられるようにする。載るのはこの payload の `run.toolCalls[].assistantId` が指す応答のうち `messages` に入らないものだけに限り、値の無い項目はキーごと省略する（run の開始時刻・ツール実行時刻・再読み込み時刻で代用しない）。**同じ BFF プロセスが SDK 履歴と `messageMetrics` を保持している間だけ**の値で、再起動・アイドル sweep の後の payload と旧サーバーはキー自体を省く（[ask-user.md](ask-user.md#回答待ちカードの復帰)）。

`ToolCall.assistantId` はそのツールを要求した assistant 応答のID。ライブの `tool_start` / `run.toolCalls` / `messages[].tools` で同じ値になり、再接続後もカードの所有者を応答IDで決められる。

`ToolCall.startedAt` / `endedAt` は BFF が `tool_execution_start` / `tool_execution_end` の到着時刻で測ったツール実行の開始 / 終了（epoch ms）。`metrics` と同じく SDK は実行時刻を持たないため BFF 側でしか作れず、run を跨いで控えた値を `messages[].tools` / `run.toolCalls` / `tool_start` / `tool_end` の同じ toolCall に同じ値で載せる（クライアントは差分を実行時間として出す）。片方でも欠けたカードは実行時間を出さない（停止・中止で `tool_execution_end` が来なかったカードは `endedAt` が無い）。**この 2 つは BFF のメモリにしか無く、再起動とアイドル sweep で消える**（pi entry はツール実行の開始時刻を持たず、同じ assistant メッセージの複数ツールを `toolResult` の `timestamp` から区別できない。[persistence.md](persistence.md#会話履歴の扱い)）。

`messages[].tools` は表示対象の assistant バブルに属する確定済みツール履歴。対応する `toolResult` がある toolCall だけを `ToolCall` DTO（`done: true`）で投影し、結果が無い call は含めない。`args` / `output` はライブイベントと同じマスク・要約関数を通し、**マスクの後に**、ツール契約で値がパスと決まっている引数（`path` / `file_path` / `filePath`）だけを `./` 付きの cwd 相対へ畳む（先に畳むと cwd をまたぐ秘密値が完全一致しなくなり、後段のマスクをすり抜ける）。`command` / `output` / `path` を持たないツールの JSON 引数（本文）は畳まない: 本文の `<cwd>/…` に見える語はパスとは限らず（grep の検索語、`case` のパターン、`[ ]` の照合語）、`./…` へ書き換えるとコピーしたコマンドの挙動が変わる（表示文字列はコピーにもそのまま使う）。cwd の外は絶対のまま残し、root 相対と基準を混ぜない。`skill` はライブ専用で、スキル読み込み（`read` で basename が `SKILL.md`）はここに含めず `skillLoads` のバッジだけに出す。ask_user の `questions` / `answers` は逆に**ライブと履歴の両方で同じ `ToolCall` に載る**（`tool_start` / `tool_end` / `run.toolCalls` と `messages[].tools` が同じ値）。本文の無い assistant に属するツール履歴は同じ user ターン内の次の表示 assistant へ part 順で繰り上げる。繰り上げ先がそのターンに無いとき（停止・中断した応答、ツールだけの最終応答）は、その応答自身を本文の空な表示 item にしてツールをそこへ残す（同じターンに本文なし応答が複数あれば所有者ごとに item にし、1 つの item へ寄せない。表示の正は `displayableMessageSet()`、件数も同じ集合で数える）。ターンを越えて運ぶことはしない。ask_user は回答待ちの間だけ resync が assistant バブルを合成する（[ask-user.md](ask-user.md#回答待ちカードの復帰)）。

`resync` は `messages[].tools` を `ToolCard` へ変換し、`toolCallId` → バブルの索引も再構築する。重複する `run.toolCalls` は現在の実行状態を優先して該当カードを更新し、履歴に無い call だけを現在ターンの最後の assistant バブルへ追加する。`messages` は有効コンテキストの投影なので、全履歴の表示は `history` API（下記）が担う。500 件の長い履歴で payload サイズと生成・JSON 化時間を検証する（`messages` に全履歴は含めない）。

### スキル読み込み（`skillLoads` / `skill`）

`messages[].skillLoads` と `run.toolCalls[].skill` は、`read` で **basename が `SKILL.md`** の呼び出し（スキル読み込み）を示す導出値。判定は server の純関数 `classifySkillRead()` 1 箇所に集約し、履歴（`projectMessages()`）とライブ（`tool_execution_start`）で共有する。専用の保存フィールドは持たず、pi entry から毎回導出する（[persistence.md](persistence.md)）。

- `name` は解決後の絶対パスの**親ディレクトリ名**（pi ネイティブと同じ）。frontmatter の `name` とは一致しないことがあり、`foo/SKILL.md` に `name: bar` があってもバッジは `[skill] foo` になる（一覧 / `/skill:` は frontmatter の `name` を使うため食い違い得る）。**撤去済みのカタログ仮想パス（`.u7agent/agent-skills/<name>/SKILL.md`）だけは**、過去の履歴を表示するためにセグメントの percent encoding をデコードした元の名前をバッジへ出す（この表示用の変換だけを残し、索引・本文の解決は戻さない。`path` は保存された encoded のまま）。`path` は解決後の絶対パス（pi の展開表示は cwd 相対だが、ライブ / 履歴で同じ値にするため絶対で統一する）。`offset` / `limit` は `read` の引数をそのまま持つ
- cwd は絶対 session cwd（`workspaceAbs(rootCwd, record.workdir)`）に統一する。対応する path は絶対 / 相対 / `.` / `..` のみで、`~` 展開・`@` 接頭辞・`file://`・Unicode スペース正規化は非対応（該当しない）。組み込みの仮想パス（`.u7agent/builtin-skills/<name>/SKILL.md`）も同じ規則で成立する（厳密な name 照合はしない）
- `skillLoads` は「**このバブルに出す分**（繰り上げ分を含む）」。`isDisplayableMessage()` は本文を要求するため、`read` だけの assistant メッセージは表示集合から落ち、**同じ user ターン内の次の表示可能な assistant メッセージへ繰り上げる**（メッセージ順 → part 順、繰り上げ分が先）。次の user メッセージは越えず、ターン内に表示可能なメッセージが無ければ落とす（既知の制限。ツールカードを残すために本文の空な item になるターンでは、同じ応答の `skillLoads` もその item に載る）。繰り上げても `messages` の件数と `messageCount` は変えない
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

## `POST /api/sessions/:id/messages`

メッセージ送信。**202 で即時返却**し、ランは裏で続く。実行中に呼ぶとキューに積まれる（最大 10 件、超過は 429）。

```json
// request
{ "text": "README を読んで改善案を 3 つ" }
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
- `text` が `/skill:` で始まるときは、BFF が本文ブロックへ展開してから送る（[`/skill:` の展開](#skill-の展開)）。
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
- 名前は優先順位 `プロジェクト > 共通 > 組み込み` で一意に解決する（[一覧 API](#get-apisessionsidskills) と同じ解決を共有）。共通 / 組み込みスキルはセッションのエージェントスナップショットの `commonSkillNames` / `builtinSkillNames`（[api-catalog.md](api-catalog.md#エージェント定義のスキル許可リスト)）で絞られ、外した名前は未知の名前と同じに素通しする（エラーにしない）。未知の名前、`/skill:` で始まらない本文も素通しする（SDK と同じ挙動）
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
| `usage` | `{ usage?, metrics?, context?, assistantId? }`（assistant の `message_end` ごとに 1 件。usage はプロバイダが報告したときだけ、metrics は BFF 計測、context は SDK の `getContextUsage()` だが履歴反映前なので確定値は `run_end` 側） |
| `assistant_end` | `{ assistantId? }`（assistant の `message_end` ごとに 1 件。その応答の本文（`message_end` でのみ届く末尾を含む）と `usage` を配った後に届き、クライアントは開いている応答カードを閉じて、続く `text` を次の応答のカードへ入れる。usage / metrics は載せない。未知のイベントは購読側で無視できる） |
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
