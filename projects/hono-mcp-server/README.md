# hono-mcp-server

Honoフレームワークを利用したMCP（Model Context Protocol）サーバーの実装です。

## トランスポート

MCPプロトコルを使って通信し、さまざまなツール機能を提供します。
本サーバーは「Streamable HTTP transport」で待ち受けているため、Streamable HTTPに対応したクライアントから接続可能です。

## プラグイン

本サーバーはHono上に公式のMCP用プラグインを導入し、MCPサーバーとしての機能を提供しています。

<https://github.com/honojs/middleware/tree/main/packages/mcp>

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

MCPクライアント設定 (Streamable HTTP):

```json
{
  "servers": {
    "localhost:3000": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
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
