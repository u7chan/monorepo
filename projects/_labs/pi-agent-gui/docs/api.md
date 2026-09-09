# HTTP API リファレンス

静的ファイル（`/`）以外は `/api/` 配下。JSON は `Content-Type: application/json`。

DTO の正は `server/src/schema.ts`（zod）。リクエストボディは `@hono/zod-validator` で検証され、client（`client/src/api.ts`）は `hono/client`（hc）でこの契約を型として参照する。

## ヘルスチェック

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | pi ランタイムの状態（`ready` / `model` / `availableModels` / `cwd`） |

## エージェント / スキル

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | エージェントとスキルの一覧 |
| PUT | `/api/agents` | エージェント定義をJSONで一括置換 |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, skillIds }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新 |
| DELETE | `/api/agents/:id` | エージェント削除（最後の 1 体は削除不可） |
| GET | `/api/skills` | スキル一覧 |
| POST | `/api/skills` | スキル作成 `{ name, description, prompt }` |
| PATCH / PUT | `/api/skills/:id` | スキル更新 |
| DELETE | `/api/skills/:id` | スキル削除（エージェントの割り当てからも外れる） |

### エージェント定義のインポート / エクスポート

管理画面の「インポート」「エクスポート」から、エージェントとスキルを JSON ファイルで扱えます。
ファイルの形式は `/api/agents` の GET レスポンスと同じです。

```json
{
  "agents": [
    {
      "id": "agent-builder",
      "name": "実装パートナー",
      "description": "コード実装を支援",
      "systemPrompt": "…",
      "skillIds": ["skill-short"]
    }
  ],
  "skills": [
    {
      "id": "skill-short",
      "name": "短く答える",
      "description": "結論と次の一手を優先する",
      "prompt": "まず結論を答える"
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
      "agentName": "実装パートナー",
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

セッション作成。body は任意（`{ "agentId": "agent-cat" }` を渡せる）。201 でセッションペイロードを返す。

### `GET /api/sessions/:id`

セッションペイロード。会話履歴（`messages`）と実行状態（`status` / `run`）、SSE のカーソル（`lastSeq`）を含む。

```json
{
  "sessionId": "…",
  "status": "running",
  "queueDepth": 0,
  "lastSeq": 42,
  "title": "…",
  "model": "…",
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

### `POST /api/sessions/:id/stop`

実行中のランを中断し、待機キューを破棄する。`{ ok: true, status: "stopped" }` を返す。旧 `POST /api/sessions/:id/abort` も同じ動作のエイリアス。

### `DELETE /api/sessions/:id`

停止してセッションを破棄。購読中の SSE には `session_deleted` が通知される。
