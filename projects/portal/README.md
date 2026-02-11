# Docker Container Portal

Bun + React + TypeScriptで構築された、Dockerコンテナを可視化・管理するWebポータルアプリケーション。

## 機能

- **コンテナ一覧表示**: ホスト上の全Dockerコンテナをカード形式で表示
- **ポートリンク**: 公開ポートをクリック可能なリンクとして表示（http://localhost:PORT）
- **ステータス表示**: 実行中/停止中などの状態を視覚的に表示
- **フィルタリング**: 全て/実行中/停止中でフィルタ可能
- **自動更新**: 30秒ごとに自動リフレッシュ
- **サイバーパンクUI**: ダークテーマ + グロー効果 + ホバーアニメーション
- **モックデータモード**: Docker不要でUI開発・レイアウト確認が可能

## 技術スタック

- **バックエンド**: Bun.serve()（Express不使用）
- **フロントエンド**: React 19 + TypeScript
- **スタイリング**: Tailwind CSS 4
- **コンテナ連携**: Bun.$ テンプレートリテラル（docker psコマンド実行）

## クイックスタート

### 開発モード

```bash
bun install
bun dev
```

http://localhost:3000 でアクセス

### モックデータモード（Docker不要）

Dockerがインストールされていない環境や、レイアウト確認用にモックデータを使用する場合：

```bash
# モックモードで開発
bun run dev:mock

# または環境変数を直接指定
USE_MOCK_DATA=true bun dev

# モックモードで本番確認
bun run start:mock
```

モックデータには以下のテスト用コンテナが含まれています：
- 各種状態（running, exited, paused, restarting）
- 長い名前のコンテナ
- 複数ポートを持つコンテナ
- ポートなしのコンテナ

### 本番実行

```bash
bun start
```

### Dockerビルド

```bash
docker build -t portal .
```

### 本番デプロイ

本番環境では `../../deploy/portal.yml` を使用：

```bash
docker-compose -f ../../deploy/portal.yml up -d
```

## APIエンドポイント

| エンドポイント | メソッド | 説明 |
|--------------|---------|------|
| `/api/containers` | GET | コンテナ一覧取得（`?filter=all\|running\|stopped`） |
| `/api/hello` | GET/PUT | ヘルスチェック用 |
| `/api/hello/:name` | GET | パスパラメータ例 |

## プロジェクト構造

```
.
├── src/
│   ├── index.ts              # Bun.serve() エントリポイント
│   ├── index.html            # HTMLテンプレート
│   ├── frontend.tsx          # Reactエントリ
│   ├── App.tsx               # メインアプリコンポーネント
│   ├── APITester.tsx         # APIテスト用コンポーネント
│   ├── index.css             # グローバルスタイル
│   ├── types/
│   │   └── container.ts      # 型定義
│   ├── services/
│   │   ├── docker.ts         # Docker CLIサービス
│   │   ├── mockData.ts       # モックデータ（Docker不要モード用）
│   │   └── docker.test.ts    # ユニットテスト
│   └── components/
│       ├── ContainerCard.tsx # コンテナカード
│       └── ContainerList.tsx # コンテナリスト
├── Dockerfile                # Dockerイメージ定義
├── build.ts                  # ビルドスクリプト
└── package.json
```

## テスト

```bash
bun test              # テスト実行
bun test --watch      # ウォッチモード
```

## 本番Docker Compose設定

本番環境の設定は `../../deploy/portal.yml` を参照：

- **ポート**: 3000:3000
- **Docker Socket**: /var/run/docker.sock
- **再起動**: always
- **ネットワーク**: home_network

## 要件

- Bun 1.3.8+
- Docker（ホストマシンまたはDocker Socketマウント）※ モックモード使用時は不要
