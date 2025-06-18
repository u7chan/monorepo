# hono-mcp-middleware-server

## 概要

Hono が提供するMCPサーバー向けプラグインを使ったサンプル実装です。

## Hono MCP Server の構築手順

パッケージマネージャー及びランタイムには [bun](https://bun.sh/) を利用。

1. Create Project

    ```sh
    bun create hono@latest
    ```

1. Install MCP Server SDK

    ```sh
    bun i @modelcontextprotocol/sdk
    ```

1. Install MCP Plugin by Hono

    ```sh
    bun i @hono/mcp
    ```

1. 公式の[サンプル](https://github.com/honojs/middleware/tree/main/packages/mcp)をコピペ

    ```ts
    # src/index.ts

    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
    import { StreamableHTTPTransport } from '@hono/mcp'
    import { Hono } from 'hono'

    const app = new Hono()

    // Your MCP server implementation
    const mcpServer = new McpServer({
      name: 'my-mcp-server',
      version: '1.0.0',
    })

    app.all('/mcp', async (c) => {
      const transport = new StreamableHTTPTransport()
      await mcpServer.connect(transport)
      return transport.handleRequest(c)
    })
    ```

1. サーバーを起動

    ```sh
    bun run dev
    $ bun run --hot src/index.ts
    ```

    エラーは起きていないがサーバーとして待ち受けていない感じ🤔

1. bun で起動する場合、`export default app`が必要のため、追加する

    ```diff
    # src/index.ts

    // ファイルの末尾に追加

    + export default app
    ```

1. サーバーを起動

    ```sh
    bun run dev
    $ bun run --hot src/index.ts
    Started development server: http://localhost:3000
    ```

1. ブラウザで <http://localhost:3000/mcp> を開く

    ```json
    {"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept text/event-stream"},"id":null}
    ```

    動いていそう！

## ツールの実装と確認

1. Install Zod

    ```sh
    bun i zod
    ```

1. ツールのコードを追加

    ```ts
    # src/index.ts

    mcpServer.tool('reverse_string', '入力文字列を反転します', { text: z.string() }, ({ text }) => {
      return {
        content: [
          {
            type: 'text',
            text: text.split('').reverse().join(''),
          },
        ],
      }
    })
    ```

1. サーバーを起動

    ```sh
    bun run dev
    ```

1. MCP Inspector でテスト

    - セットアップコマンド (要Node.js)

      ```sh
      DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector
      ```

    - サーバー起動後は <http://127.0.0.1:6274>

1. MCP Inspector の接続設定

    - Transport Type: Streamable HTTP
    - URL: <http://localhost:3000/mcp>

1. Connect > reverse_string > text (任意の文字列) > Run Tool
