# file-server

Bun + Hono + HTMX で構築されたWebベースのファイルサーバー/マネージャー。
ブラウザ上でファイルのアップロード・閲覧・削除・ディレクトリ作成が行える。
認証を有効化した場合は、ユーザーごとに保存領域を分離できる。

## 機能

- ファイル/ディレクトリのブラウジング（パンくずナビゲーション付き）
- ファイルアップロード（ドラッグ&ドロップ対応、最大10ファイルまで一括アップロード可能）
- ファイルプレビュー・編集（テキスト、画像、動画、PDF ※テキストはブラウザ上で直接編集可能）
- ファイル/ディレクトリの削除
- ディレクトリ作成
- HTMXによるページ遷移なしの動的UI更新
- パス検証によるディレクトリトラバーサル防止
- オプション認証（ログイン/ログアウト、セッションCookie）
- 認証有効時のユーザーごとのディレクトリ分離

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| ランタイム | [Bun](https://bun.sh) |
| フレームワーク | [Hono](https://hono.dev) |
| フロントエンド | [HTMX](https://htmx.org) + [Tailwind CSS](https://tailwindcss.com) v4 |
| バリデーション | [Zod](https://zod.dev) |
| 言語 | TypeScript + JSX |
| リンター/フォーマッター | [Biome](https://biomejs.dev) |

## プロジェクト構成

```
src/
├── index.tsx              # エントリーポイント
├── types.ts               # 型定義
├── api/
│   └── handlers.tsx       # APIリクエストハンドラー
├── middleware/
│   └── auth.ts            # 認証ミドルウェア
├── routes/
│   ├── api.ts             # REST APIルート定義
│   ├── auth.tsx           # ログイン/ログアウトルート
│   ├── browse.tsx         # ディレクトリブラウズルート
│   └── file.tsx           # ファイル表示/ダウンロードルート
├── components/
│   ├── PageShell.tsx      # HTMLシェルレイアウト
│   ├── FileList.tsx       # ファイル一覧コンポーネント
│   ├── file-viewer/       # ファイルタイプ別ビューアー
│   │   ├── index.tsx
│   │   ├── FileViewerModal.tsx
│   │   ├── TextViewer.tsx
│   │   ├── ImageViewer.tsx
│   │   ├── VideoViewer.tsx
│   │   ├── PdfViewer.tsx
│   │   └── DefaultViewer.tsx
│   └── icons/             # SVGアイコンコンポーネント
└── utils/
    ├── auth.ts            # セッション署名/検証、認証ユーティリティ
    ├── fileListing.ts     # ファイル一覧取得
    ├── fileUtils.ts       # パス検証、ソート
    ├── formatters.ts      # サイズ・日時フォーマット
    ├── pathTraversal.ts   # ディレクトリトラバーサル判定
    ├── requestUtils.tsx   # リクエストユーティリティ
    └── userConfigCache.ts # ユーザー設定キャッシュ
scripts/
└── hash-password.ts       # パスワードハッシュ生成CLI
tests/
├── auth.test.ts           # 認証・ユーザー分離テスト
├── read.test.ts           # ファイル閲覧テスト
├── upload.test.ts         # アップロードテスト
├── delete.test.ts         # 削除テスト
├── mkdir.test.ts          # ディレクトリ作成テスト
└── update.test.ts         # ファイル更新テスト
```

## APIエンドポイント

### REST API

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/*` | ファイル/ディレクトリ一覧取得 |
| POST | `/api/upload` | ファイルアップロード（複数ファイル可、最大10件） |
| POST | `/api/delete` | ファイル/ディレクトリ削除 |
| POST | `/api/mkdir` | ディレクトリ作成 |
| POST | `/api/update` | ファイル更新（テキスト編集保存） |

### HTMLルート

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/` | ディレクトリブラウズ（メインUI） |
| GET | `/browse` | ディレクトリ一覧（HTMX部分更新用） |
| GET | `/file` | ファイルビューアー表示 |
| GET | `/file/raw` | ファイルの生データ配信 |
| GET | `/login` | ログイン画面 |
| POST | `/login` | ログイン処理 |
| POST | `/logout` | ログアウト処理 |

## セットアップ

### 必要環境

- [Bun](https://bun.sh) v1.3.10+

### 開発

```bash
# 依存関係のインストール
bun install

# 開発サーバー起動（ホットリロード付き）
bun run dev

# リント
bun run lint

# フォーマット
bun run format

# テスト
bun test

# パスワードハッシュ生成
bun run hash-password 'your-password'
```

### 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `UPLOAD_DIR` | ファイル保存ディレクトリ | `./tmp` |
| `USERS_FILE` | ユーザー設定JSONファイルへのパス（設定時に認証有効） | 未設定 |
| `SESSION_SECRET` | セッション署名シークレット（`USERS_FILE` 設定時は必須） | 未設定 |

### `USERS_FILE` 例

```json
[
  {
    "username": "alice",
    "passwordHash": "$2b$10$..."
  }
]
```

### 開発時にユーザー認証を有効化する手順

1. パスワードハッシュを生成する。

```bash
bun run hash-password 'alice-password'
```

2. プロジェクトルート（`README.md` と同じ階層）に `users.dev.json` を作成する。

```bash
touch users.dev.json
```

3. `users.dev.json` に `username` と `passwordHash` を設定する。

```json
[
  {
    "username": "alice",
    "passwordHash": "$2b$10$..."
  }
]
```

4. `SESSION_SECRET` と `USERS_FILE` を指定して開発サーバーを起動する。

```bash
SESSION_SECRET='replace-with-32+chars-secret' \
USERS_FILE='./users.dev.json' \
bun run dev
```

5. ブラウザで `http://localhost:3000/login` を開き、設定したユーザーでログインする。

### 本番環境での `SESSION_SECRET` 運用

- `SESSION_SECRET` は 32 文字以上の十分に長いランダム値を使う（推奨: 64 バイト相当）。
- ソースコードや Git にコミットしない。環境変数として注入する。
- 複数インスタンス運用時は、同一サービスで同じ `SESSION_SECRET` を共有する。
- 定期ローテーションを行う（切り替え時は既存セッション失効を想定）。

生成例:

```bash
openssl rand -base64 48
```

Docker 例:

```bash
docker run -p 3000:3000 \
  -e SESSION_SECRET='generated-secret' \
  -e USERS_FILE='/app/users.json' \
  -e UPLOAD_DIR='/app/uploads' \
  file-server
```

## Docker

```bash
# ビルド
docker build -t file-server .

# テスト実行
docker build --target=test .

# 実行
docker run -p 3000:3000 -e UPLOAD_DIR=/app/uploads -v $(pwd)/data:/app/uploads file-server
```

### Dockerfileの構成（マルチステージ）

1. **base** - Node 24 Alpine + Bun
2. **test** - lint + テスト実行
3. **builder** - 本番依存関係のインストール
4. **final** - 本番イメージ（非rootユーザー実行、ポート3000）
