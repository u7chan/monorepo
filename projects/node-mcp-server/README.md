# node-mcp-server

Node.js と TypeScript で実装した MCP サーバーのサンプルです。

## 使い方

### インストール

```sh
npm install
```

### ビルド

以下のコマンドを実行すると、`dist/bundle.js` が生成されます。

```sh
npm run build
```

### サーバーの起動

Node.js でサーバーを起動できます。

```sh
node dist/bundle.js
```

### 開発サーバーの起動

```sh
npm run dev
```

### MCP クライアントの設定例

MCP クライアントで `node-mcp-server` を利用する場合の設定例です。

```json
{
  "mcpServers": {
    "node-mcp-server": {
      "command": "node",
      "args": ["<fullpath>/monorepo/projects/node-mcp-server/dist/bundle.js"]
    }
  }
}
```
