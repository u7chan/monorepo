# chat-mcp-client

OpenAI互換のChat Completion APIを提供するサーバー。

## API

### POST /api/chat/completions

OpenAI Chat Completion APIと互換性のあるエンドポイント。

#### リクエスト

```bash
curl -N http://localhost:3000/api/chat/completions \
  -H "Content-Type: application/json" \
  -H "mcp-server-urls: http://localhost:8000/sse" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "temperature": 0.7,
    "maxTokens": 100
  }'
```

#### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| model | string | 任意 | モデル名（未指定時は `LITELLM_API_DEFAULT_MODEL` を使用） |
| messages | array | 必須 | メッセージの配列 |
| temperature | number | 任意 | 0-1の範囲 |
| maxTokens | number | 任意 | 最大トークン数 |

#### ヘッダー

| ヘッダー | 説明 |
|---------|------|
| mcp-server-urls | MCPサーバーのURL（カンマ区切りで複数指定可能） |

#### レスポンス

SSE (Server-Sent Events) でストリーミングされる。

## テスト

```bash
# デフォルト設定
./test-chat.sh

# カスタム設定
API_URL=http://localhost:8080 MODEL=gpt-4.1-mimi ./test-chat.sh
```

## 環境変数

| 変数名 | 説明 |
|-------|------|
| LITELLM_API_BASE_URL | LiteLLM APIのベースURL |
| LITELLM_API_KEY | LiteLLM APIのキー |
| LITELLM_API_DEFAULT_MODEL | デフォルトモデル |
