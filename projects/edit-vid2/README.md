# edit-vid2

Bun + Hono + React + TanStack Router による動画編集アプリ。

## 前提

- [Bun](https://bun.sh) 1.x
- [FFmpeg](https://ffmpeg.org) (`ffmpeg` / `ffprobe` コマンド)
- SQLite （自動生成）

## 開発

```bash
# 依存関係インストール
bun install

# 開発サーバー起動
bun run dev

# スキーマ変更後
bun run db:generate
bun run db:migrate
```

## 検証

```bash
bun run lint         # tsc && oxlint
bun run format:check # oxfmt --check
bun test             # bun test
bun run build        # vite build
```

## 本番起動

```bash
bun run build
NODE_ENV=production DATABASE_URL=data/edit-vid2.db bun run start
```

## データ

- `data/edit-vid2.db` - SQLite データベース
- `data/videos/{videoAssetId}/` - アップロード動画とサムネイル
- `data/projects/{projectId}/previews/` - 字幕プレビュー画像
- `data/exports/{exportJobId}/` - 書き出し成果物とログ

## Docker

```bash
docker build -t edit-vid2 .
docker run -p 3000:3000 -v $(pwd)/data:/app/data edit-vid2
```

## 環境変数

| 変数               | デフォルト          | 説明                |
| ------------------ | ------------------- | ------------------- |
| `SERVER_PORT`      | `3000`              | サーバーポート      |
| `DATABASE_URL`     | `data/edit-vid2.db` | SQLite ファイルパス |
| `MAX_UPLOAD_BYTES` | `2147483648` (2GB)  | アップロード上限    |
| `LOG_LEVEL`        | `info`              | ログレベル          |
