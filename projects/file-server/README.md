# file-server

Bun + Hono + HTMX で構築されたWebベースのファイルサーバー/マネージャー。
ブラウザ上でファイルのアップロード・作成・閲覧・削除・ディレクトリ作成が行える。
認証を有効化した場合は、ユーザーごとに保存領域を分離できる。

## 機能

- ファイル/ディレクトリのブラウジング（パンくずナビゲーション付き）
- ファイルアップロード（ドラッグ&ドロップ対応、最大10ファイルまで一括アップロード）
- ファイルプレビュー・編集（テキスト、画像、動画、PDF ※テキストはブラウザ上で直接編集可能）
- 表示中ディレクトリ配下の Zip ダウンロード（親ディレクトリのラッパーなし）
- 空ファイル作成
- ファイル/ディレクトリの削除・リネーム
- ディレクトリ作成
- **外部公開URL配信 (`GET /public/*`)**: 認証不要で `UPLOAD_DIR/public/` 以下のファイルを直接配信（HTML/SVG等のアクティブコンテンツは403ブロック）
- **スコープ分離**: `UPLOAD_DIR` を `public/`・`private/` に分割し、ユーザーごとに保存領域を隔離
- HTMXによるページ遷移なしの動的UI更新
- パス検証によるディレクトリトラバーサル防止
- オプション認証（ログイン/ログアウト、セッションCookie）
- 認証有効時のロールベース保存領域（`user` は `private/<username>/` 配下のみ、`admin` は全体）

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| ランタイム | [Bun](https://bun.sh) |
| フレームワーク | [Hono](https://hono.dev) |
| フロントエンド | [HTMX](https://htmx.org) + [Tailwind CSS](https://tailwindcss.com) v4 |
| バリデーション | [Zod](https://zod.dev) |
| 言語 | TypeScript + JSX |
| リンター/フォーマッター | [Biome](https://biomejs.dev) |

## ディレクトリ構成

### UPLOAD_DIR のレイアウト

```
UPLOAD_DIR/
├── public/      # GET /public/* で外部公開されるファイル
└── private/     # ユーザー別プライベートファイル
    ├── alice/
    └── bob/
```

起動時（`createApp()` 実行時）に `public/` と `private/` ディレクトリが自動作成される。

### バーチャルパスと実パスの対応

| バーチャルパス | 説明 |
|---|---|
| `` (空) | ルート: synthetic `[public, private]` を返す |
| `public/...` | `UPLOAD_DIR/public/...` に解決 |
| `private/...` | auth 無効: `UPLOAD_DIR/private/...` に解決 / auth 有効: ロールに応じてスコープ制限 |
| `private/<username>/...` | 当該ユーザーのみアクセス可（admin は全ユーザーにアクセス可） |

### プロジェクト構成

```
src/
├── index.tsx              # エントリーポイント
├── app.ts                 # createApp() ファクトリ
├── types.ts               # 型定義
├── api/
│   └── handlers.tsx       # APIリクエストハンドラー
├── middleware/
│   └── auth.ts            # 認証ミドルウェア
├── routes/
│   ├── api.ts             # REST APIルート定義
│   ├── auth.tsx           # ログイン/ログアウトルート
│   ├── browse.tsx         # ディレクトリブラウズルート
│   ├── file.tsx           # ファイル表示/ダウンロードルート
│   └── public.tsx         # 外部公開ファイル配信ルート
├── components/
│   ├── PageShell.tsx      # HTMLシェルレイアウト
│   ├── FileList.tsx       # ファイル一覧コンポーネント
│   ├── file-viewer/       # ファイルタイプ別ビューアー
│   └── icons/             # SVGアイコンコンポーネント
└── utils/
    ├── auth.ts            # セッション署名/検証、認証ユーティリティ
    ├── fileListing.ts     # ファイル一覧取得
    ├── fileUtils.ts       # パス検証、ソート
    ├── formatters.ts      # サイズ・日時フォーマット
    ├── pathTraversal.ts   # ディレクトリトラバーサル判定
    ├── requestUtils.tsx   # リクエストユーティリティ
    ├── userConfigCache.ts # ユーザー設定キャッシュ
    └── virtualPath.ts     # バーチャルパス解決・書き込み権限チェック
scripts/
└── hash-password.ts       # パスワードハッシュ生成CLI
tests/
├── helpers/
│   ├── createTestApp.ts   # テスト用アプリファクトリ
│   └── auth.ts            # テスト用セッション生成
├── auth.test.ts           # 認証・ユーザー分離テスト
├── read.test.ts           # ファイル閲覧テスト
├── upload.test.ts         # アップロードテスト
├── delete.test.ts         # 削除テスト
├── create-file.test.ts    # 空ファイル作成テスト
├── mkdir.test.ts          # ディレクトリ作成テスト
├── rename.test.ts         # リネームテスト
├── update.test.ts         # ファイル更新テスト
└── public-route.test.ts   # 外部公開ルートテスト
```

## APIエンドポイント

### 外部公開配信（認証不要）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/public/*` | `UPLOAD_DIR/public/` のファイルを直接配信（HTML/SVG は403ブロック） |

### REST API（認証必須 ※auth有効時）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/*` | バーチャルパスのファイル/ディレクトリ一覧取得 |
| POST | `/api/upload` | ファイルアップロード（複数ファイル可、最大10件） |
| POST | `/api/delete` | ファイル/ディレクトリ削除 |
| POST | `/api/file` | 空ファイル作成 |
| POST | `/api/mkdir` | ディレクトリ作成 |
| POST | `/api/rename` | ファイル/ディレクトリのリネーム |
| POST | `/api/update` | ファイル更新（テキスト編集保存） |

### HTMLルート

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/` | ディレクトリブラウズ（メインUI） |
| GET | `/browse` | ディレクトリ一覧（HTMX部分更新用） |
| GET | `/file` | ファイルビューアー表示 |
| GET | `/file/raw` | ファイルの生データ配信 |
| GET | `/file/archive` | 表示中ディレクトリ配下を Zip でダウンロード |
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

# テスト
bun test

# パスワードハッシュ生成
bun run hash-password 'your-password'
```

### 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `UPLOAD_DIR` | ファイル保存ルートディレクトリ | `./tmp` |
| `USERS_FILE` | ユーザー設定JSONファイルへのパス（設定時に認証有効） | 未設定 |
| `SESSION_SECRET` | セッション署名シークレット（`USERS_FILE` 設定時は必須） | 未設定 |

### `USERS_FILE` 例

```json
[
  {
    "username": "alice",
    "passwordHash": "$2b$10$...",
    "role": "user"
  },
  {
    "username": "admin",
    "passwordHash": "$2b$10$...",
    "role": "admin"
  }
]
```

`role` は必須で、`"user"` または `"admin"` のみ指定できる。不正な値は設定エラーとして扱われる。
`public` と `private` はシステム予約語のため、ユーザー名に使用できない。

### 開発時にユーザー認証を有効化する手順

1. パスワードハッシュを生成する。

```bash
bun run hash-password 'alice-password'
```

2. プロジェクトルートに `users.dev.json` を作成し、ユーザーを設定する。

```json
[
  {
    "username": "alice",
    "passwordHash": "$2b$10$...",
    "role": "user"
  }
]
```

3. `.env` に環境変数を設定して開発サーバーを起動する。

```bash
cp .env.example .env
# .env を編集して USERS_FILE と SESSION_SECRET を設定
bun run dev
```

認証時のパスとスコープの対応:
- `role: "user"`: `private/<username>/` のみアクセス可
- `role: "admin"`: 全スコープにアクセス可

`bun run` 実行時は Bun が `.env` を自動で読み込む。

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

## 破壊的変更とマイグレーション

### v0.x → 現在（Issue #806）

`UPLOAD_DIR` のレイアウトが変更された。既存のデータを移行するには以下を実行する:

```bash
# 旧レイアウト: UPLOAD_DIR/<username>/
# 新レイアウト: UPLOAD_DIR/private/<username>/

mkdir -p UPLOAD_DIR/private
for dir in UPLOAD_DIR/*/; do
  username=$(basename "$dir")
  if [ "$username" != "public" ] && [ "$username" != "private" ]; then
    mv "$dir" "UPLOAD_DIR/private/$username"
  fi
done
```

APIパスも変更されている:

| 旧パス | 新パス |
|---|---|
| `GET /api/` (一般ユーザー) | `GET /api/private/<username>/` |
| `GET /api/` (admin) | `GET /api/private/` |
| アップロード `path: "<username>"` | アップロード `path: "private/<username>"` |
| アーカイブ `?path=<username>` | アーカイブ `?path=private/<username>` |

## Docker

現在のランタイムイメージでは `zip` コマンドをインストールしており、`/file/archive` はその `zip` コマンドを使って表示中ディレクトリ配下の子要素だけをアーカイブする。

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
