# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

## ヘルスチェック

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | pi ランタイムの状態（`ready` / `model` / `modelOptions` / `defaultThinkingLevel` / `cwd`）。認証が無い場合は `errorCode: "authentication_required"` |

`ready` は「ランタイムが使え、利用可能モデルが 1 つ以上ある」の意で、アプリ既定モデル（`model`）が使えるかとは独立している。明示 `PI_MODEL` が利用不能でも候補が他にあれば `ready: true` と `defaultModelError` を返し、別モデルへは自動で切り替えない。`sandboxConfigured` は `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が揃っているか（未設定ならセッション作成が 503 になる）を示す。

```json
{
  "ok": true,
  "ready": true,
  "sandboxConfigured": true,
  "model": "deepseek/deepseek-v4-flash",
  "availableModels": ["deepseek/deepseek-v4-flash"],
  "modelOptions": [
    {
      "provider": "deepseek",
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "supportsThinking": true,
      "thinkingLevels": ["off", "low", "high", "max"]
    }
  ],
  "defaultThinkingLevel": "medium",
  "defaultModelError": "指定された既定モデルは利用できません: openai/ghost"
}
```

`modelOptions` は認証済みで利用可能なモデルのみ。能力情報（`supportsThinking` / `thinkingLevels`）は pi SDK の公開ヘルパー（`getSupportedThinkingLevels`）から得る。`defaultThinkingLevel` は `PI_MODEL` の末尾指定 → `PI_THINKING` → `medium` の優先順位で決まる。

## サンドボックス ツール実行API（内部）

BFF が作業用ツール（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）の実行を委譲する内部API。ブラウザから直接呼ぶAPIではなく、`AppType` には含まれない。ホストへ公開せず、BFF ⇄ サンドボックスの内部ネットワークのみで到達する。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/healthz` | 無認証。Compose healthcheck 用。`{ ok, tools, cwd, runningExecutions }` |
| POST | `/v1/tools/:tool/execute` | ツール実行。NDJSON ストリームで応答 |
| POST | `/v1/executions/:id/cancel` | 実行中のツールを中断 |

認証は `Authorization: Bearer <PI_SANDBOX_TOKEN>`。未認証は 401、未知のツールは 404、`params` がオブジェクトでない場合は 400。

### `POST /v1/tools/:tool/execute`

リクエストボディは `{ toolCallId?: string, params?: object }`。応答は `Content-Type: application/x-ndjson` で、1 イベント 1 行:

```jsonl
{"type":"start","executionId":"…"}
{"type":"update","payload":{"content":[…],"details":{…}}}
{"type":"result","payload":{"content":[…]}}
```

- `start` — 実行開始。`executionId` は cancel に使う
- `update` — SDK ツールの `onUpdate`（bash の累積出力スナップショット等）を relay
- `result` — 正常終了。ストリームはここで閉じる
- `error` — 異常終了（`{ "type": "error", "message": "…" }`）。SDK ツールが throw したメッセージ

クライアント（BFF）が切断した場合もサンドボックスは実行を中断する。明示的な中断は cancel エンドポイントか `AbortSignal` の伝播で行う。

### `POST /v1/executions/:id/cancel`

実行中のツール（`start` で払い出された `executionId`）を中断する。SDK ツールへ `AbortSignal` が伝わり、bash は子プロセスを殺して `Command aborted` エラーになる。実行が無い場合は 404。

### 環境変数

| 変数 | サービス | 説明 |
| --- | --- | --- |
| `PI_SANDBOX_URL` | BFF | サンドボックスの到達先（例: `http://pi-agent-gui-sandbox:8080`）。未設定ならセッション作成を 503 で拒否 |
| `PI_SANDBOX_TOKEN` | BFF + サンドボックス | Bearer トークン（16 文字以上）。LLM 認証情報とは別の値 |
| `PI_SANDBOX_CWD` | サンドボックス | ツール実行の既定 cwd（既定 `/workspace`） |
| `SANDBOX_PORT` | サンドボックス | ポート（既定 8080。ホストへ publish しない） |

## エージェント / スキル

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | エージェントとスキルの一覧 |
| PUT | `/api/agents` | エージェント定義をJSONで一括置換 |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, skillIds, model?, thinkingLevel? }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新（キー省略は保持、`null` は指定解除） |
| DELETE | `/api/agents/:id` | エージェント削除（最後の 1 体は削除不可） |
| GET | `/api/skills` | スキル一覧 |
| POST | `/api/skills` | スキル作成 `{ name, description, prompt }` |
| PATCH / PUT | `/api/skills/:id` | スキル更新 |
| DELETE | `/api/skills/:id` | スキル削除（エージェントの割り当てからも外れる） |

### エージェント定義の Model / Effort

エージェント定義には任意の `model`（`{ provider, id }`）と `thinkingLevel` を持たせられます。それぞれ独立して任意で、片方だけの指定や、Model 未指定で Effort だけの指定もできます。既定の組み込みエージェントはどちらも未指定です。

- GET / export は未指定項目のキーを省略し、`null` は保存・応答に現れない。
- 更新要求はキー省略で保持、`model: null` / `thinkingLevel: null` で指定解除する。
- import はキー省略を未指定として受け付け、旧形式（追加項目なし）のファイルもそのまま使える。利用不能なモデル参照も形式が正しければ定義には保持できる（実行時に検証してエラーになる）。
- 不正な `ModelRef` や未知の `thinkingLevel` は 400。

```json
{
  "agents": [
    {
      "id": "agent-reviewer",
      "name": "コードレビュー",
      "description": "バグや保守性の問題を重要度順にレビューする",
      "systemPrompt": "…",
      "skillIds": ["skill-severity-review"],
      "model": { "provider": "openai", "id": "gpt-5.5" },
      "thinkingLevel": "high"
    }
  ],
  "skills": [
    {
      "id": "skill-severity-review",
      "name": "重要度順レビュー",
      "description": "指摘を重要度順に並べ、根拠と修正案を添える",
      "prompt": "指摘は重要度の高い順に並べてください。…"
    }
  ]
}
```

### エージェント定義のインポート / エクスポート

管理画面の「インポート」「エクスポート」から、エージェントとスキルを JSON ファイルで扱えます。
ファイルの形式は `/api/agents` の GET レスポンスと同じです。

```json
{
  "agents": [
    {
      "id": "agent-builder",
      "name": "コード実装",
      "description": "コードを読んで、安全に変更を実装する",
      "systemPrompt": "…",
      "skillIds": ["skill-change-report"]
    }
  ],
  "skills": [
    {
      "id": "skill-change-report",
      "name": "変更レポート",
      "description": "最後に変更点と確認方法を箇条書きで報告する",
      "prompt": "作業の最後に、変更したファイル・各変更の要点・動作確認の方法・残った課題を箇条書きで報告してください。"
    }
  ]
}
```

`PUT /api/agents` は現在のエージェント / スキル定義を読み込んだ内容で置き換えます。既存の会話やセッションは変更しません。開発中のため `version` フィールドは持たせず、マイグレーションや後方互換性も考慮しません。

## セッション

### `GET /api/sessions`

セッション一覧（最終使用の新しい順）。

```json
{
  "sessions": [
    {
      "sessionId": "…",
      "title": "README をレビューして",
      "agentId": "agent-builder",
      "agentName": "コード実装",
      "status": "running",
      "queueDepth": 0,
      "messageCount": 4,
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000001000,
      "model": "zai/glm-5.3-flash"
    }
  ]
}
```

### `POST /api/sessions`

セッション作成。body は任意。

```json
{ "agentId": "agent-reviewer", "model": { "provider": "openai", "id": "gpt-5.5" }, "thinkingLevel": "high" }
```

- `model` / `thinkingLevel` はそれぞれ optional（`null` は 400）。省略した項目は「エージェント定義 → アプリ既定」の順に解決する。
- 明示されたモデルは利用可能一覧の provider/id と厳密照合し、利用不能なら 400、利用可能モデル自体がゼロなら 503。いずれも pi SDK のセッション作成前に拒否する。
- 作成時に指定した値はそのチャット内だけに適用され、定義や他のチャットへは波及しない。201 でセッションペイロードを返す。

### `GET /api/sessions/:id`

セッションペイロード。会話履歴（`messages`）と実行状態（`status` / `run`）、SSE のカーソル（`lastSeq`）を含む。

```json
{
  "sessionId": "…",
  "status": "running",
  "queueDepth": 0,
  "lastSeq": 42,
  "title": "…",
  "model": "deepseek/deepseek-v4-flash",
  "thinkingLevel": "high",
  "supportsThinking": true,
  "availableThinkingLevels": ["off", "low", "high", "max"],
  "cwd": "…",
  "agent": { "id": "…", "name": "…", "skills": ["…"] },
  "run": {
    "id": "…",
    "status": "running",
    "startedAt": 1700000000000,
    "toolCalls": [{ "id": "…", "name": "read", "args": "README.md", "done": true, "isError": false, "output": "…" }]
  },
  "messages": [
    { "role": "user", "text": "…" },
    { "role": "assistant", "text": "…", "stopReason": "stop" }
  ]
}
```

`model` / `thinkingLevel` は pi SDK のセッションが持つ実効値（`thinkingLevel` は SDK 補正後）。`supportsThinking` と `availableThinkingLevels` はその実効モデルの能力を SDK の公開ヘルパーから引いたもの。`agent` は作成時点のスナップショットなので、定義を編集・削除しても既存チャットの表示は変わらない。

### `PATCH /api/sessions/:id/settings`

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

### `POST /api/sessions/:id/messages`

メッセージ送信。**202 で即時返却**し、ランは裏で続く。実行中に呼ぶとキューに積まれる（最大 10 件、超過は 429）。

```json
// request
{ "text": "README を読んで改善案を 3 つ" }
// response (202)
{ "sessionId": "…", "status": "running", "queued": false, "queueDepth": 0, "runId": "…" }
```

### `GET /api/sessions/:id/events?after=N`

SSE（`text/event-stream`）でイベントを購読。`after`（未指定時は `Last-Event-ID` ヘッダ）以降のイベントをリプレイしてからライブ配信する。

イベントタイプ:

| イベント | data |
| --- | --- |
| `run_start` | `{ runId, prompt }` |
| `text` | `{ delta }` |
| `tool_start` / `tool_end` | `{ id, name, args }` / `{ id, name, isError, output }` |
| `status` | `{ state, text }`（考え中 / ツール実行中 / 再試行中 など） |
| `queued` | `{ position, queueDepth, prompt }` |
| `queue_cleared` | `{}` |
| `run_end` | `{ runId, status, error, messageCount, queueDepth }` |
| `resync` | セッションペイロード全体（バッファを逃した場合） |
| `session_deleted` | `{ sessionId }`（削除時。送出後に接続を閉じる） |

テキスト系イベント（`text` / `tool_start` / `tool_end` / `run_start` / `queued` / `run_end` のエラーや `resync` の `messages` など）は、既知のプロバイダーAPIキーの値が `[REDACTED]` に置換されて配信される。対象キーと保証範囲は README の「APIキーの保護」を参照。

### `POST /api/sessions/:id/stop`

実行中のランを中断し、待機キューを破棄する。`{ ok: true, status: "stopped" }` を返す。旧 `POST /api/sessions/:id/abort` も同じ動作のエイリアス。

### `DELETE /api/sessions/:id`

停止してセッションを破棄。購読中の SSE には `session_deleted` が通知される。
