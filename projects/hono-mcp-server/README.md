# hono-mcp-server

Honoフレームワークを使用したMCP (Model Context Protocol) サーバー実装です。  
SSE (Server-Sent Events) を介してクライアントと通信し、様々なツール機能を提供します。

## 主な機能

- 現在時刻の取得
- Base64エンコード/デコード
- 日本語から英語への翻訳
- Web検索機能

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

各機能はMCPクライアントから以下のように呼び出せます:

- 現在時刻取得:
  ```json
  {
    "tool_name": "get_current_time"
  }
  ```

- Base64エンコード:
  ```json
  {
    "tool_name": "base64_encoding",
    "arguments": {
      "text": "エンコードするテキスト"
    }
  }
  ```

- 翻訳:
  ```json
  {
    "tool_name": "translate_to_english",
    "arguments": {
      "text": "翻訳する日本語テキスト"
    }
  }
  ```

- Web検索:
  ```json
  {
    "tool_name": "web_serach",
    "arguments": {
      "text": "検索クエリ"
    }
  }
  ```

## 開発者向け情報

- 新しい機能を追加するには`src/features`ディレクトリに新しいモジュールを作成
- `tools`の定義は`src/index.ts`で管理
- リンター: `bun run lint`
- フォーマット: `bun run format`