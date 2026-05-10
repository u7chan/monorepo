---
name: portfolio-db-bootstrap
description: portfolio プロジェクトで Docker の PostgreSQL コンテナを用意し、`DATABASE_URL` を指定して `db:migrate` と `db:user:add` を順に実行する開発用DB初期化で使う。
---

# portfolio DB Bootstrap

portfolio の開発用 PostgreSQL を Docker で用意し、Drizzle migration と開発用認証ユーザー作成まで行う。

## 使う場面

- DB コンテナが未起動、または作り直したい
- Drizzle migration を最新化したい
- 開発用ユーザーを 1 件入れたい

## 前提

- 作業ディレクトリは `projects/portfolio`
- コンテナ名は `portfolio-postgres`
- 既存コンテナや既存ユーザーがある場合は、破壊的な削除を勝手に行わず状況を報告する

## 設定値

この skill 内で使う値はここで管理する。

```sh
DB_CONTAINER=portfolio-postgres
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=portfolio
DB_HOST=localhost
DB_PORT=5432
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/portfolio
INITIAL_USER_EMAIL=test@example.com
INITIAL_USER_PASSWORD=testexample
```

## 手順

1. `docker ps -a --filter name=portfolio-postgres` で既存コンテナを確認する
2. コンテナがなければ `postgres:17-alpine` を `5432:5432` で起動する
3. コンテナが停止中なら `docker start portfolio-postgres` で起動する
4. `pg_isready` が成功するまで待つ
5. `DATABASE_URL` を指定して `bun run db:migrate` を実行する
6. `bun run db:user:add -- --email "$INITIAL_USER_EMAIL"` を実行し、パスワードは標準入力で渡す
7. `users` テーブルを確認して登録済みか検証する
8. 最後に `DATABASE_URL` の値をユーザーへ提示する

`db:user:add` は同じメールアドレスが既に存在すると失敗する。既存なら追加作業は不要として扱い、必要ならユーザーに作り直すか確認する。

## コマンド例

先に「設定値」の変数をセットしてから実行する。

```sh
docker run -d --name "$DB_CONTAINER" --restart unless-stopped \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$DB_PORT":5432 \
  postgres:17-alpine

docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME"

DATABASE_URL="$DATABASE_URL" bun run db:migrate
printf '%s\n' "$INITIAL_USER_PASSWORD" | DATABASE_URL="$DATABASE_URL" bun run db:user:add -- --email "$INITIAL_USER_EMAIL"
```

## 確認

- `docker ps` で `portfolio-postgres` が起動中であること
- `docker exec portfolio-postgres pg_isready -U postgres -d portfolio` が成功すること
- `docker exec portfolio-postgres psql -U postgres -d portfolio -c "select email from users;"` で `$INITIAL_USER_EMAIL` が入っていること
- 環境作成後に接続文字列 `$DATABASE_URL` をユーザーへ提示すること
