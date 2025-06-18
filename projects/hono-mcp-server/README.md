# hono-mcp-server

Honoフレームワークを利用したMCP（Model Context Protocol）サーバーの実装です。

## トランスポート

SSE（Server-Sent Events）を介してクライアントと通信し、さまざまなツール機能を提供します。  
本サーバーは「SSE Transport」で待ち受けているため、クライアントはSSE（サーバー送信イベント）を使って接続できます。

## プラグイン

本サーバーはHono上に非公式の「SSE Transport」用プラグインを導入し、MCPサーバーとしての機能を実現しています。

[hono-mcp-server-sse-transport](https://github.com/NikaBuligini/hono-mcp-server-sse-transport)

また、[Hono v4.8.0](https://github.com/honojs/hono/releases/tag/v4.8.0) では公式にMCPミドルウェアのプラグインが追加されており、さらに`Streamable HTTP Transport`で動作し、コードの記述量も減少するため、今後はこの公式プラグインが主に活用される見込みです。

## 技術スタック

| カテゴリ | 技術/ツール | バージョン/詳細 |
|----------------|---------------------------|------------------------------------|
| ランタイム | Bun | 1.x系 (oven/bun:alpine ベース) |
| Webフレームワーク | Hono | 4.x系 |
| 言語 | TypeScript | 5.x系 |
| ORM/バリデーション | Zod | 3.x系 |
| ロギング | log4js | 6.x系 |
| AI統合 | OpenAI API | 4.x系 |
| MCP統合 | @modelcontextprotocol/sdk | 1.x系 |
| フォーマッター | Biome | 1.x系 |
| コンテナ | Docker | Alpine Linuxベース |
| 環境 | タイムゾーン | Asia/Tokyo |

## 接続方法

MCPクライアント設定 (SSE):

```json
{
  "servers": {
    "localhost:3000": {
      "type": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## セットアップ手順

1. リポジトリをクローン:

   ```bash
   git clone git@github.com:u7chan/monorepo.git
   ```

1. VSCodeでプロジェクトを開く

   ```bash
   cd projects/hono-mcp-server
   code .
   ```

1. DevContainerを使った開発環境の起動:
   1. VS Codeでプロジェクトを開いておく
   1. VS Codeの拡張機能から「Dev Containers」をインストールしておく
   1. 左下の緑色の「><」アイコンをクリック
   1. 「Reopen in Container」を選択
   1. コンテナが起動し、自動的に依存関係がインストールされます

1. サーバーを起動:

   ```bash
   bun run dev
   ```

## 使用方法

各機能はMCPクライアントを通じて動作することが可能です。

## 開発者向け情報

- 新しい機能を追加するには`src/features`ディレクトリに新しいモジュールを作成
- `tools`の定義は`src/index.ts`で管理
- リンター: `bun run lint`
- フォーマット: `bun run format`
