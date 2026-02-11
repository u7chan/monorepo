# Docker Container Portal - 設計方針

## 目的
Dockerコンテナが公開しているポート（外部アクセス可能なポート）へのリンクを、
カード形式で一覧表示するWebポータルを構築する。

## アーキテクチャ

### 全体構成
```
┌─────────────────┐
│   ブラウザ      │ ← ユーザーがアクセス
└────────┬────────┘
         │ HTTP (port 3000)
┌────────▼────────┐
│  Node.js Server │ ← Express + Dockerode
│  (コンテナ)     │
└────────┬────────┘
         │ /var/run/docker.sock (マウント)
┌────────▼────────┐
│  Docker Daemon  │ ← ホストのDocker
│  (ホスト)       │
└─────────────────┘
```

## コンポーネント設計

### 1. フロントエンド (docker-portal.html)
- **役割**: UIの描画とユーザーインタラクション
- **技術**: Pure HTML/CSS/JavaScript (フレームワークなし)
- **機能**:
  - コンテナ情報をカード形式で表示
  - 各カードに公開ポートへのリンクを配置
  - リアルタイム更新 (30秒ごと)
  - フィルタリング (実行中/全て)

### 2. バックエンド (server.js)
- **役割**: Docker APIとの通信、データ提供
- **技術**: Node.js + Express + Dockerode
- **機能**:
  - `/api/containers` エンドポイント提供
  - Docker socketから全コンテナ情報を取得
  - ポート情報のパース・整形

### 3. Docker統合
- **Docker socket マウント**: `/var/run/docker.sock:/var/run/docker.sock:ro`
- **セキュリティ**: 読み取り専用 (`:ro`) でマウント
- **仕組み**: Dozzleと同様、ホストのDocker APIに直接アクセス

## データフロー

### コンテナ情報取得フロー
```
1. フロントエンド → GET /api/containers
2. バックエンド → docker.listContainers({ all: true })
3. Docker Daemon → コンテナ一覧を返却
4. バックエンド → ポート情報をパース
5. フロントエンド → カード形式でレンダリング
```

### ポート情報のパース
```
Docker API返却データ:
{
  "Ports": [
    {
      "PrivatePort": 80,
      "PublicPort": 8080,
      "Type": "tcp",
      "IP": "0.0.0.0"
    }
  ]
}

↓ パース後

{
  "url": "http://localhost:8080",
  "privatePort": 80,
  "publicPort": 8080
}
```

## UI/UX設計

### カード表示項目
- **コンテナ名**: Names[0] から取得
- **イメージ名**: Image フィールド
- **ステータスバッジ**: running / stopped
- **ポートリンク**: 公開ポートごとにクリック可能なリンク

### デザインコンセプト
- サイバーパンク/テック系の美しいUI
- カードベースのグリッドレイアウト
- ホバーアニメーション、スムーズなトランジション
- レスポンシブ対応

## デプロイ方法

### docker-compose使用
```
services:
  docker-portal:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
```

参考ファイル: `../../deploy/*.yml`

### 必要な権限
- Docker socketへの読み取りアクセス
- ポート3000のバインド

## セキュリティ考慮事項

### リスク
- Docker socketへのアクセス = ホストへの強い権限
- コンテナから全てのコンテナ情報が見える

### 対策
- 読み取り専用マウント (`:ro`)
- 信頼できるネットワーク内でのみ使用
- 必要に応じて認証レイヤーを追加
