# セッション API

規約と索引は [api.md](api.md) を参照する。設計の背景は [run-lifecycle.md](run-lifecycle.md)、compaction は [compaction.md](compaction.md)、Model / Effort は [model-effort.md](model-effort.md) を正とする。

このファイルはセッションの一覧と取得を持つ。履歴と状態は [api-session-state.md](api-session-state.md)、送信と会話の中身は [api-session-turns.md](api-session-turns.md)、実行の観測と終了は [api-session-runtime.md](api-session-runtime.md) に分かれる。

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
      "titleSummary": {
        "origin": "ai",
        "attempt": { "runId": "…", "at": 1700000009000, "state": "done", "trigger": "auto", "model": "<provider>/<id>", "thinkingLevel": "low" }
      },
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

`titleSummary` は会話タイトルの由来 (`origin`: `auto` / `ai` / `manual`) と最新の AI 要約の試行
(`attempt`: `runId` / `at` / `state` / `trigger` / `model` / `thinkingLevel` / `generation` / `usage` /
`durationMs` / `error` / `skipReason`) を表す。タイトル本文は `title` が持つ。`attempt` はまだ試行が無ければ
省略し、旧サーバーは `titleSummary` 自体を省略する (クライアントは未対応として扱う)。`state` は `pending` /
`done` / `failed` / `skipped`、`skipReason` は `disabled` / `model-unset` / `manual` / `no-request` /
`cancelled` / `settings-changed` / `not-ready` / `interrupted`。`error` はマスク済み・長さ上限つきで、依頼本文と生成タイトルは
載せない (詳細は [session-title.md](session-title.md#実行のタイミングと試行))。

`runStartedAt` / `finishedAt` は live な実行の開始・終了、`compactionStartedAt` は圧縮の開始、`awaitingSince` は未 settle の質問のうち最も古い開始時刻、`lastRunDurationMs` は直近のランの所要時間（`runOutcomes` にあるときだけ）で、どれも該当が無ければキーを省略する。未ロードの会話は `idle` でこれらの時刻を載せない（`lastUsedAt` を開始時刻の代用にしない）。終了済みの live レコードは終了から 120 分の間だけ sweep の対象外になる。

`pinned` はサイドバーで固定するかを示す（常に boolean）。`awaitingAnswer` は `ask_user` の未 settle の回答待ちがあるか（省略 = false）。この間もランは `running` のままで、左バーの行が「回答待ち」になる（[ask-user.md](ask-user.md#ui)）。待機を持たない未ロードの会話は省略し、ロード済みの会話は待機が無くても `false` を返す。`canHandoff` は同じ会話のままエージェント / スペースを引き継げるか（常に true。旧サーバーは省略 = false）。`parentSessionId` は分岐元の会話 id（分岐していない会話と旧サーバーはキーを省略する。分岐先はこの値から引く）。`projectSession` はプロジェクト所属か（真では引き継ぎ先のスペースを選ばない）。`handoffCleanup` は確定後の履歴削除（片付け）が残っているか（省略 = false。真の間は開く要求が 409 になり、新しい引き継ぎも受け付けない）。`hasRawLog` は生ログ（`session.jsonl`）がディスクにあるか（省略 = false）。設定 → ランタイム の診断タブは、まだ診断応答を取れていないときの出し分けにこの値を使い、応答が取れていれば `raw.available` を正とする。false のときだけダウンロードを押せなくし、理由を 1 行で出す（[diagnostics.md](diagnostics.md#取れないもの)）。`projectId` は所属プロジェクト（未所属はキーを省略する）。所属は保存された `projectCwd` をプロジェクト一覧と突き合わせて読み取り時に解決するため、プロジェクトを解除すると配下セッションは未所属として返る（セッションと履歴・ピン状態は残る）。復元したセッションも同じ規則で解決する。

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
  "titleSummary": {
    "origin": "ai",
    "attempt": { "runId": "…", "at": 1700000009000, "state": "done", "trigger": "auto", "model": "<provider>/<id>", "thinkingLevel": "low" }
  },
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

`model` / `thinkingLevel` は pi SDK のセッションが持つ実効値（`thinkingLevel` は SDK 補正後）。`supportsThinking` と `availableThinkingLevels` はその実効モデルの能力を SDK の公開ヘルパーから引いたもの。`agent` は作成時点のスナップショット（スキル許可リスト・`allowNaturalInvocationBuiltin` / `allowNaturalInvocationFile`・`toolNames` を含む）なので、定義を編集・削除しても既存チャットの表示とツールの実効は変わらない。分割前の旧セッション meta にある `allowNaturalInvocation` は応答へは載せず、スコープごとの値へ解決して読む（[api-catalog.md](api-catalog.md#自然文での発火)）。

`status` は `idle` / `running` / `queued` / `compacting` / `completed` / `stopped` / `error`。`compacting` は手動圧縮の実行中で、SDK の実行中だけでなく**保存待ち**も含む（排他の正は BFF のフラグ。詳細は [compaction.md](compaction.md#手動圧縮)）。`compactionStartedAt` はその開始時刻（epoch ms）で、`status` が `compacting` のときだけ載る（終端の `resync` では載せない）。経過時間の起点はこの値を使い、`run.startedAt` は再利用しない。

`serverNow` は payload を組み立てたサーバー基準時刻（epoch ms）。`run.retry.retryAt` との差でクライアントが待機の残り時間を出すための値で、ブラウザの時計と直接比較してはならない（リロード / SSE 再接続 / 別タブでも同じ残り時間を復元する。詳細は [run-lifecycle.md](run-lifecycle.md#再試行状態の配信と復元)）。

`run.retry` は進行中の自動再試行で、`phase` は SDK の backoff 待機中 (`waiting`) か、次の assistant の応答開始後 (`retrying`)。`reason` は `auth_required` / `insufficient_quota` / `context_overflow` / `rate_limit` / `unknown` の分類コードだけで、上流のエラー原文は載らない。`run.totalRetryCount` はラン中の再試行スケジュール回数の累計（`auto_retry_start` の通知数。待機中の中止も含む）で、成功・最終失敗後も結果表示用に残る。新しいランでは 0 へ戻る。成功・最終失敗・停止でアクティブな `retry` は消える（復元時に「いつまで待機中か」を誤らないため）。

`run.errorCode` は最終失敗の分類コードで、`run.status === "error"` のときだけ載る（`error` と組になる）。停止要求と listener 例外 / `prompt()` reject が同時に起きたランは `stopped` のままで、コードを載せない。クライアントは `rate_limit` / `unknown` のときだけ再実行カードを出し、それ以外は状態行の文言だけを出す（[frontend.md](frontend.md#チャット状態とレンダリング)）。

`cwd` はワークスペース root 相対の作業ディレクトリ（プロジェクト所属は `projectCwd`、未所属は所属スペースのスクラッチ。置き場は [session-files.md](session-files.md#スペースごとの配置)）。ツール実行と `GET /api/files` の結果はこのディレクトリを起点に組み立てる。`write` / `edit` はこのディレクトリと `<root>/.agents/skills` の内側にだけ書ける（[projects.md](projects.md#write--edit-の書き込み範囲)）。`health.cwd` は root の絶対パス（表示用）で意味が違う。`projectId` は所属プロジェクト（未所属はキーを省略）。復元時は `meta.projectCwd` から `cwd` を解決し、登録が解除・消失していてもそのディレクトリを使う。

`eventGeneration` は SSE の世代（[イベント購読](api-session-runtime.md#get-apisessionsidevents) を参照）。`lastSeq` と組でカーソルの整合判定に使う。

`pendingSends` は 202 で受理したが user entry としてまだ保存されていない送信（古い→新しい）。要素は `{ sendId, runId?, text, at, state, position? }` で、`text` は表示用にマスク済み、`runId` は実行へ割り当て済みのときだけ載る（手動圧縮待ちなど未割当の送信では省略する）。`state` は `unsent`（未送信）/ `queued`（配送待ち。取消できる）/ `steering`（SDK が取り出して反映中。取消・再送・破棄は不可）/ `running`（実行中）で、`queued` と `steering` の境目は SDK の実キューから取り出されたかどうか。判定は `server/src/schema.ts` の `PendingSendSchema` と `server/src/session-steering.ts` / `server/src/session-payload.ts` を正とする。`position` は **BFF の配送キューの並び**（SDK へ渡した分も含む）の index + 1 で、`queueDepth` も同じ集合を数える（上限も同じ件数で判定する）。送信の照合・取消・再送・破棄はすべて `sendId` で行い、`runId` は実行への所属だけを表す。

`pendingSends` の並び（受理順）は再送で実際のキューの並びと入れ替わる（再送は末尾へ積まれ、受理の記録は元の位置に残る）ため、順位は並びから数えず `position` を読む。クライアントは未保存の送信を「未送信」へ切り替え、配送に残る送信は受理済みの pending として保つ（別タブの再送中に表示から消さない。履歴の初回応答前でもバブルを足す）。手元にバブルが無い未送信は末尾へ足し、一覧から消えた未送信は別タブの再送 / 破棄として落とす（[frontend.md](frontend.md#チャット状態とレンダリング)）。再送は本文を送り直さず `POST /api/sessions/:id/messages` の `resendSendId` へ `sendId` を渡す（マスク済みの本文をモデルへ送らないため）。「実行中」は `run.status === "running"` か SDK が streaming のときだけで、**終了した実行の送信は配送対象から外れて `unsent` になる**（`error` で終わって user entry を残さなかった送信も再送 / 破棄できる）。旧サーバーはこのキーを載せないので、省略 = 0 件ではなく未対応として扱う（`state` があっても `position` が無いときは順位が不明として扱う）。

`handoff` は直前の引き継ぎの状態（`{ operationId, at, memo, consumed, cleanupPending }`）。`operationId` は引き継ぎごとのランダムな 8 hex、`memo` は `HANDOFF.md` を書いたか、`consumed` は引き継ぎ後に最初の送信を受理済みか（未送信の破棄では戻らない）、`cleanupPending` は片付けが残っているか。チップ「HANDOFF.mdを参照」は `memo && !consumed` のときだけ出す（表示はクライアントのメモリではなくこの値から導出する。 [ui-layout.md](ui-layout.md#スペース)）。引き継ぎを受けていない会話と旧サーバーはキーを省略する。

JSONL が破損している（SDK が追記する entry type / message role を store が知らない、途中の行が壊れている等）セッションを開く要求は 409（store のパスを含む文言）で拒否する。原本は書き換えず、一覧にも残る（[session-files.md](session-files.md#会話の保存)）。開けなかったときのクライアントの移り先は [frontend.md](frontend.md#クライアントの-effect-契約) を参照。

`messages[].assistantId` は BFF が実行内で割り当てた assistant 応答ID（`<runId>:<seq>`）。同じ応答の `text` / `tool_start` / `assistant_end` と、保存済み entry / 履歴 item が同じ値を持つ。旧保存データではキーを省略する。

`messages[].at` は pi SDK が履歴に持つメッセージの作成時刻（epoch ms）。assistant は生成開始時刻で、完了時刻ではない。SDK が時刻を持たない履歴ではキーを省略する（受け手は時刻無しでも表示を壊さない）。

`messages[].model` は assistant を生成したモデル（`provider/model`）。SDK の `provider` / `model` から作り、どちらかが欠ける / `unknown/unknown` の応答は `null`（モデル不明）にする。user は持たず、旧サーバーはキーを省略する。クライアントは履歴ヘッダーの表示名に使い、完全な識別子はラベルの `title` に出す。

`messages[].usage` は SDK の `AssistantMessage.usage` をそのまま通したもの（`cost` は pi-ai の `calculateCost` 済み。料金表が無いモデルは 0）。`cacheWrite1h` / `reasoning` は報告するプロバイダだけが返す。プロバイダが usage を報告しないときはキーを省略し、0 に置き換えない（受け手は数字を出さない）。

`messages[].metrics` は応答時間のメタ。`durationMs` は応答の所要時間、`ttftMs` は最初の text / thinking delta まで（delta が無ければ省略）、`tokensPerSecond` は `output` を最初の delta からの時間で割った値（スパンが 0 以下なら `durationMs`、それも 0 なら省略）。ツールループで assistant メッセージが複数あるときはメッセージごとに付く。

由来は `source` が持つ。解決順は「BFF がメモリ上で計測した値 → アプリ DB に保存した実測（`assistant_metrics`）→ SDK が履歴に記録した `durationMs` からの導出 → 無し」で、この順序は `server/src/session-projection.ts` の解決関数だけが持つ。`source` の省略は `measured` として扱い、`recorded` のときだけ表示側が概算の印を付ける（正は `client/src/lib/usageFormat.ts`）。

| 由来 | 条件 | 表示 |
| --- | --- | --- |
| `measured`（`source` 省略） | BFF が `message_start` から `message_end` までの到着時刻で計測した | `1.8s · 42.3 tok/s` |
| `measured`（`source` 省略） | 再起動・アイドル sweep の後、アプリ DB の `assistant_metrics` を `assistantId` で引き当てた | `1.8s · 42.3 tok/s`（tok/s は算出できたときだけ） |
| `recorded` | メモリ実測も DB 実測も無く、SDK の `durationMs` が 1 以上かつ usage の `output` が 1 以上 | `≈1.8s · ≈42 tok/s` |
| 未記録 | どれも無い（旧セッション・DB の行が無い・deferred の結果・`durationMs` が 0・usage 未報告） | 時間と tok/s を出さない |

DB から復元した実測には、`recorded` に掛けている「tok/s が揃わなければ出さない」ゲートを掛けない。usage を報告しないプロバイダでも、再起動後に応答時間まで消えないようにするため。tok/s は `duration_ms` / `ttft_ms` / `output_tokens` から live と同じ規則で導出し、算出できなければキーを省略する（0 で埋めない）。つまり usage 未報告の会話でも、再起動後に時間は出て tok/s だけが出ない。集計（プロバイダ / モデルごとの生成速度の推移）はこの DB の実測だけを使い、SDK 記録値（`recorded`）は使わない。

`recorded` の `durationMs` は SDK がリクエスト送信前から測った値なので、BFF の計測（`message_start` = レスポンスヘッダ受信後から）より接続待ちのぶん**大きく**なる。同じ応答では tok/s の分母にもその待ちが乗るため、BFF の計測より**小さく**出る。TTFT は SDK の記録値からは復元できない（最初の delta の時刻が JSONL に残らない）ため `ttftMs` を載せない（DB 実測は `ttft_ms` を保存するので載る）。`recorded` の metrics は `messages[].metrics` と `assistantMeta[].metrics` の両方に載り得る。

`assistantMeta` は `messages` に現れない assistant 応答の `{ assistantId, at?, model?, usage?, metrics? }`（配列）。表示 item にならない応答（本文が無く、確定したツールカードも持たない応答）でも、未回答の ask_user カードは復帰のために assistant バブルを合成するため、元の応答の時刻と応答時間を `assistantId` で引き当てられるようにする。載るのはこの payload の `run.toolCalls[].assistantId` が指す応答のうち `messages` に入らないものだけに限り、値の無い項目はキーごと省略する（run の開始時刻・ツール実行時刻・再読み込み時刻で代用しない）。`model` は `messages[].model` と同じく、`provider` / `model` が欠ける / `unknown/unknown` の応答では `null` にする。**値の解決は `messages[].metrics` と同じ順序**（BFF のメモリ実測 → アプリ DB の実測 → SDK 記録値からの概算）なので、再起動・アイドル sweep のあとでも、SDK 履歴に `durationMs` と usage が残っていれば時刻・usage・応答時間は載る。どれも持たない応答と旧サーバーはキー自体を省く（[ask-user.md](ask-user.md#回答待ちカードの復帰)）。

`ToolCall.assistantId` はそのツールを要求した assistant 応答のID。ライブの `tool_start` / `run.toolCalls` / `messages[].tools` で同じ値になり、再接続後もカードの所有者を応答IDで決められる。

`ToolCall.startedAt` / `endedAt` は BFF が `tool_execution_start` / `tool_execution_end` の到着時刻で測ったツール実行の開始 / 終了（epoch ms）。`metrics` と同じく SDK は実行時刻を持たないため BFF 側でしか作れず、run を跨いで控えた値を `messages[].tools` / `run.toolCalls` / `tool_start` / `tool_end` の同じ toolCall に同じ値で載せる（クライアントは差分を実行時間として出す）。片方でも欠けたカードは実行時間を出さない（停止・中止で `tool_execution_end` が来なかったカードは `endedAt` が無い）。**この 2 つは BFF のメモリにしか無く、再起動とアイドル sweep で消える**（pi entry に残るのは `toolResult` の `durationMs` / `toolCallId` と結果作成時の `timestamp` だけで、BFF が観測した `startedAt` / `endedAt` そのものは残らない。[persistence.md](persistence.md#会話履歴の扱い)）。

`messages[].tools` は表示対象の assistant バブルに属する確定済みツール履歴。対応する `toolResult` がある toolCall だけを `ToolCall` DTO（`done: true`）で投影し、結果が無い call は含めない。`args` / `output` はライブイベントと同じマスク・要約関数を通し、**マスクの後に**、ツール契約で値がパスと決まっている引数（`path` / `file_path` / `filePath`）だけを `./` 付きの cwd 相対へ畳む（先に畳むと cwd をまたぐ秘密値が完全一致しなくなり、後段のマスクをすり抜ける）。`command` / `output` / `path` を持たないツールの JSON 引数（本文）は畳まない: 本文の `<cwd>/…` に見える語はパスとは限らず（grep の検索語、`case` のパターン、`[ ]` の照合語）、`./…` へ書き換えるとコピーしたコマンドの挙動が変わる（表示文字列はコピーにもそのまま使う）。cwd の外は絶対のまま残し、root 相対と基準を混ぜない。`skill` はライブ専用で、スキル読み込み（`read` で basename が `SKILL.md`）はここに含めず `skillLoads` のバッジだけに出す。ask_user の `questions` / `answers` は逆に**ライブと履歴の両方で同じ `ToolCall` に載る**（`tool_start` / `tool_end` / `run.toolCalls` と `messages[].tools` が同じ値）。本文の無い assistant に属するツール履歴は同じ user ターン内の次の表示 assistant へ part 順で繰り上げる。繰り上げ先がそのターンに無いとき（停止・中断した応答、ツールだけの最終応答）は、その応答自身を本文の空な表示 item にしてツールをそこへ残す（同じターンに本文なし応答が複数あれば所有者ごとに item にし、1 つの item へ寄せない。表示の正は `displayableMessageSet()`、件数も同じ集合で数える）。ターンを越えて運ぶことはしない。ask_user は回答待ちの間だけ resync が assistant バブルを合成する（[ask-user.md](ask-user.md#回答待ちカードの復帰)）。

`resync` は `messages[].tools` を `ToolCard` へ変換し、`toolCallId` → バブルの索引も再構築する。重複する `run.toolCalls` は現在の実行状態を優先して該当カードを更新し、履歴に無い call だけを現在ターンの最後の assistant バブルへ追加する。`messages` は有効コンテキストの投影なので、全履歴の表示は [history API](api-session-state.md#get-apisessionsidhistory) が担う。500 件の長い履歴で payload サイズと生成・JSON 化時間を検証する（`messages` に全履歴は含めない）。

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
