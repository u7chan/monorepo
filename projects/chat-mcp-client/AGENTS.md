# Chat MCP Client

OpenAI互換APIにMCPツール統合を提供するサーバー。

## 開発

```bash
bun run dev      # 開発サーバー起動
bun run lint     # 型チェック + Lint
bun run format   # フォーマット
bun run test     # テスト実行
```

## API

### POST /api/chat/completions

OpenAI Chat Completions互換エンドポイント。

**ヘッダー:**
- `mcp-server-urls`: MCPサーバーURL（カンマ区切り）

**環境変数:**
- `LITELLM_API_BASE_URL`
- `LITELLM_API_KEY`
- `LITELLM_API_DEFAULT_MODEL`
