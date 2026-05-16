# Integration Plan: portfolio ↔ simple-agent-poc

## 結合方式

**API-to-API (HTTP)**: portfolio の Hono バックエンドが simple-agent-poc の FastAPI に HTTP リクエスト。

```
portfolio (Browser) ──EventSource──→ portfolio (Hono Backend)
                                          │
                                          │ HTTP (adapter)
                                          ▼
                                   simple-agent-poc (FastAPI)
                                          │
                                          ▼
                                      LiteLLM → OpenAI etc.
```

## 現状のSSEフォーマット差異

| 観点 | simple-agent-poc (Starlette) | portfolio - legacy | portfolio - session |
|:---|:---|:---|:---|
| Endpoint | `POST /api/chat/stream` | `POST /api/chat/stream` | `POST /api/chat/sessions` + `GET .../events` |
| フォーマット | `event: <type>\ndata: <JSON>\n\n` | `data: <JSON>\n\n` | `event: <type>\nid: <uuid>\ndata: <JSON>\n\n` |
| イベント種別 | `delta`, `complete`, `done`, `error` | `delta`, `finish`, `usage` (JSON内) | `user_message`, `assistant_delta`, `assistant_finish`, `usage`, `done`, `cancelled`, `error` |
| 終端 | `event: done\ndata: {}\n\n` | `data: [DONE]\n\n` | `event: done\ndata: {}\n\n` |
| IDフィールド | なし | JSON内に`id` | `id:` 行 + JSON内に`id` + `sessionId` |
| 再接続 | なし | なし | `Last-Event-ID` / `afterEventId` |
| Session管理 | `Session-Id` header or body | なし | URLパス + `sessionId` in events |
| 認証 | なし（env） | `api-key` + `base-url` header | `api-key` + `base-url` header |
| Content-Type | `text/event-stream` | `text/event-stream` | `text/event-stream` |

## 設計上の決定事項（確定済み）

### 1. 結合アーキテクチャ ✅

portfolio の Hono バックエンド内に **adapter 層** を置き、以下を担当：
- simple-agent-poc の SSE → portfolio の `ChatSessionEvent` 形式への変換
- 認証情報の管理（portfolio の api-key → simple-agent-poc の内部認証 or env）
- セッション管理の調整

### 2. SSE 形式すり合わせ ✅

**simple-agent-poc は現状の SSE 形式を維持。adapter で吸収する。**
- simple-agent-poc の session 管理方式（`InMemorySessionStore` + `Session-Id` header）を変更しない
- portfolio の session 方式（`Last-Event-ID` + `EventSource`）に合わせる必要はない
- adapter が両者の差異を吸収する

### 3. ツールコールのSSE表現 ✅

simple-agent-poc 側に以下のイベントを追加：

```
event: tool_call
data: {"call_id": "...", "name": "concat", "arguments": "{\"a\":\"hello\",\"b\":\"world\"}"}

event: tool_result
data: {"call_id": "...", "name": "concat", "result": "{\"result\":\"helloworld\"}"}
```

portfolio 側の `ChatSessionEvent.type` への追加候補：`tool_call`, `tool_result`

### 4. 認証フロー ✅

**内部API前提で認証なし。** portfolio のバックエンドがゲートウェイとなり、simple-agent-poc は同一ネットワーク内の内部APIとして運用する。

### 5. ツール定義方式 ✅

**agents.yaml はツール名のリスト。定義本体は Python 実装側に持つ。**

```yaml
tools:
  - get_current_time
  - concat
```

### 6. ビルトインツール ✅

| ツール | パラメータ | 戻り値 | Phase |
|:---|:---|:---|:---|
| `get_current_time` | なし | ISO 8601 日時文字列 | 1 |
| `concat` | `a: string, b: string` | `{"result": "..."}` | 1 |
| `ask_user` | `question: string` | `{"answer": "..."}` | 2, 3 |

## 未決定事項

- [ ] ツールコールのUI表示パターン（折りたたみ / インライン / etc.）
- [ ] reasoning（思考過程）の扱い
- [x] `ask_user` の API モード実装方式（pause/resume 二相実行の詳細）
- [ ] メッセージ型変換の詳細設計（portfolio `ApiChatMessage` ↔ simple-agent-poc `Message`）

## 実装フェーズ

### Phase 0: 設計確定 ✅
- [x] 本ドキュメント作成
- [x] SSEすり合わせ方針の決定（adapter で吸収）
- [x] ツールコール実装範囲の決定（段階的：非対話→CLI対話→API対話）
- [x] Issue 作成 → [#902](https://github.com/u7chan/monorepo/issues/902)

### Phase 1: simple-agent-poc ツールコール基盤 (Issue #902)
- [x] ツールコール型定義 (Core層 Message 拡張)
- [x] ツール実行機構 (BuiltinToolRegistry)
- [x] ReActループ (Application層 RunAgentUseCase)
- [x] API/SSE 拡張 (tool_call/tool_result イベント)
- [x] `get_current_time` + `concat` 実装

### Phase 2: simple-agent-poc ask_user CLI (Issue #904) ✅
- [x] `generator.send()` パターンによるユーザー入力注入
- [x] CLI renderer 拡張

### Phase 3: simple-agent-poc ask_user API (別Issue) ✅
- [x] pause/resume 二相実行
- [x] `POST /api/chat/continue` エンドポイント

### Phase 4: portfolio 側 結合
- [ ] Hono adapter 実装 (SSE変換, メッセージ変換)
- [ ] ツールコール UI コンポーネント
- [ ] セッション管理連携
- [ ] 結合テスト

### Phase 5: 運用
- [ ] エラーハンドリング精査
- [ ] パフォーマンス確認
- [ ] ドキュメント整備
