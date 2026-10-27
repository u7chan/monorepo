# Docker Container Portal

Bun + React + TypeScriptで構築された、Dockerコンテナを可視化・管理するWebポータルアプリケーション。

## 機能

- **ポートリンク**: 起動中のコンテナが公開しているポートを、カードごとの主役として表示。クリックで `http://<host>:PORT` を新しいタブで開く
- **コンテナ一覧表示**: ホスト上の全Dockerコンテナをカード / リストで表示（portal 自身のコンテナは除く）
- **ステータス表示**: 実行中/停止中などの状態を、色と Docker の状態文言の両方で表示
- **イメージ名のコピー**: カード/リストのコピーボタンでイメージURIをクリップボードへコピー
- **起動 / 停止**: 停止は対象ボタンの脇に出る確認ポップオーバーを経てから実行
- **フィルタリング**: 全て/実行中/停止中でフィルタ可能（件数付き）
- **自動更新**: 30秒ごとに自動リフレッシュ
- **モックデータモード**: Docker不要でUI開発・レイアウト確認が可能

## デザイン方針

この画面の仕事は「起動中のサービスを開く」ことなので、ポートを最大の要素として扱う。

- **色の役割を 1 つに固定**: 緑は「いま接続できる」の意味だけに使い、起動中コンテナのポート点灯と稼働中ステータスに限定する
- **押せるものだけ点灯**: 停止中コンテナのポートは数字を見せるがリンクにはしない（押しても繋がらないため）
- **破壊的操作は対象の脇で確認**: 停止は `window.confirm` ではなく、押したボタンに紐づくポップオーバーで確認する
- **補助情報は静かに**: イメージ名とコピーはカード下部に置き、ホバー時のみコピーボタンを出す

配色・書体は `src/index.css` の `@theme` にトークンとして定義している（`ink-*` は面、`line` は境界、`fg-*` は文字、`live` / `warn` / `dead` / `info` は状態）。

## portal 自身の除外

portal 自身が一覧に出ると、開いても portal に戻るだけの項目が並ぶ。そのため、次のいずれかに当たるコンテナは一覧から除く。

- イメージのリポジトリが `ghcr.io/u7chan/monorepo/portal`（タグ・ダイジェストは問わない）
- `HOSTNAME` が自分のコンテナ ID と一致する（docker がコンテナのホスト名に短縮コンテナ ID を入れるため）

除外は API（`/api/containers`）の返却時に行うので、件数表示も除外後の値になる。

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

### 環境変数

`.env` ファイルを作成するか、`.env.example` をコピーして使用してください。

| 変数名          | 説明                       | デフォルト    |
| --------------- | -------------------------- | ------------- |
| `PORTAL_HOST`   | ポートリンクのホスト名     | `localhost`   |
| `USE_MOCK_DATA` | モックデータモードを有効化 | `false`       |
| `NODE_ENV`      | 実行環境                   | `development` |

```bash
# リモートホストのコンテナにアクセスする場合
PORTAL_HOST=192.0.2.10 bun run dev

# 本番モードでモックデータを使用
USE_MOCK_DATA=true NODE_ENV=production bun run start
```

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

このリポジトリでは本番用 Docker Compose 定義を管理していません。CD で GHCR に push された `ghcr.io/u7chan/monorepo/portal:<tag>` を、deploy 実行側の定義から参照してください。

## APIエンドポイント

| エンドポイント     | メソッド | 説明                                                |
| ------------------ | -------- | --------------------------------------------------- |
| `/api/containers`  | GET      | コンテナ一覧取得（`?filter=all\|running\|stopped`） |
| `/api/hello`       | GET/PUT  | ヘルスチェック用                                    |
| `/api/hello/:name` | GET      | パスパラメータ例                                    |

## プロジェクト構造

```
.
├── src/
│   ├── index.ts              # Bun.serve() エントリポイント
│   ├── index.html            # HTMLテンプレート
│   ├── frontend.tsx          # Reactエントリ
│   ├── App.tsx               # ヘッダーとページ骨格
│   ├── APITester.tsx         # APIテスト用コンポーネント
│   ├── index.css             # デザイントークン (@theme) とベーススタイル
│   ├── logo.svg              # ロゴ / favicon
│   ├── types/
│   │   └── container.ts      # 型定義
│   ├── services/
│   │   ├── docker.ts         # Docker CLIサービス
│   │   ├── mockData.ts       # モックデータ（Docker不要モード用）
│   │   └── docker.test.ts    # ユニットテスト
│   ├── hooks/
│   │   ├── useConfig.ts      # ホスト名・モックモードの取得
│   │   └── useCopy.ts        # コピー完了表示
│   ├── lib/
│   │   ├── containerState.ts # 状態→色/操作の判定
│   │   ├── ports.ts          # ポートリンクの URL と表示ラベル
│   │   └── copyToClipboard.ts
│   └── components/
│       ├── ContainerCard.tsx # コンテナカード / リスト行
│       ├── ContainerList.tsx # 一覧・絞り込み・表示切替
│       ├── ConfirmPopover.tsx # 停止確認ポップオーバー
│       └── CopyButton.tsx
├── Dockerfile                # Dockerイメージ定義
└── package.json
```

## リント・フォーマット

```bash
bun lint              # 型チェック + lint
bun lint:fix          # 自動修正
bun format            # コード整形
bun format:check      # 整形チェックのみ
```

## テスト

```bash
bun test              # テスト実行
bun test --watch      # ウォッチモード
```

## 要件

- Bun 1.3.8+
- Docker（ホストマシンまたはDocker Socketマウント）※ モックモード使用時は不要
