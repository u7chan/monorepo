# Development Guide

## Why

開発時に必要なコマンドや運用手順を、`README.md` と分離して見やすく保つためです。

## What

- 開発用コマンドをまとめる
- デプロイ、DBマイグレーション、認証まわりの運用メモをまとめる

## Constraints

- 実際の `package.json` と実装に合わせる
- `README.md` は入口に留め、詳細はこのファイルに集約する

## Commands

### Run

```sh
bun run dev
```

open <http://localhost:3000/>

### Lint

```sh
bun run lint
```

### Format

```sh
bun run format
```

### Test

```sh
bun run test
```

### Test Coverage

```sh
bun run test:coverage
```

### TypeGen

```sh
bun run typegen
```

### Build

```sh
bun run build
```

### Start With Built Artifacts

```sh
bun run start
```

open <http://localhost:3000/>

## Deploy

### Image Build

```sh
docker build -t portfolio .
```

### Run Container

```sh
SERVER_PORT=3000; \
docker run \
  -p 3000:3000 \
  -itd \
  --restart=always \
  --env SERVER_PORT=$SERVER_PORT \
  portfolio
```

## Database Migration

- Dev Containers では `psql` を `postgresql-client` で利用できます

### Schema Creation

初回セットアップ時のみ実行します。

```sql
CREATE DATABASE portfolio;
```

### Create Migration

```sh
bun run db:generate
```

### Apply Migration

```sh
bun run db:migrate
```

### Add Auth User

```sh
bun run db:user:add -- --email test@example.com
```

パスワードはプロンプト入力です。非対話で実行する場合は、たとえば次のように標準入力から渡します。

```sh
printf 'replace-with-password\n' | bun run db:user:add -- --email test@example.com
```

同じメールアドレスが既に存在する場合、このコマンドは失敗します。

## Authentication Notes

- サインイン時は `users.password_hash` を使ってパスワードを検証します
- `db:user:add` は平文パスワードを対話入力または標準入力で受け取り、ハッシュ化して登録します
- チャット設定の `apiKey` はブラウザの `localStorage` に保存されます。安全な秘密情報ストアではありません
