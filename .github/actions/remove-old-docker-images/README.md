# Remove Old Docker Images Action

GHCR (GitHub Container Registry) 上の Docker イメージを、最新 N 個だけ残してそれ以外を削除するスクリプトです。

## 概要

- 指定したリポジトリ/パッケージのイメージバージョンを作成日時でソートし、KEEP_COUNT で指定した数だけ最新を残して古いものを削除します
- GHCR (ghcr.io) 専用です
- APIベースで動作し、`curl`/`jq`/`GITHUB_TOKEN` が必要です

## 使い方

```bash
./remove-old-docker-images.sh [KEEP_COUNT] <TARGET> <REGISTRY> <USERNAME> <PASSWORD>
```

- `KEEP_COUNT` : 残すイメージ数（省略時は3）
- `TARGET` : `<owner>/<repo>/<package>` 形式（例: `myorg/myrepo/myimage`）
- `REGISTRY` : `ghcr.io` のみ対応
- `USERNAME`/`PASSWORD` : レジストリログイン用（GHCRの場合はGitHubユーザー名/Personal Access Token推奨）

### 例

```bash
# 3個残す（デフォルト）
./remove-old-docker-images.sh myorg/myrepo/myimage ghcr.io <username> <token>

# 5個残す
./remove-old-docker-images.sh 5 myorg/myrepo/myimage ghcr.io <username> <token>
```

## 必要なもの

- `curl`, `jq` コマンド
- `GITHUB_TOKEN` 環境変数（GHCR API削除用、repo:delete権限が必要）

## 注意

- GHCR (ghcr.io) 以外のレジストリには未対応です
- `TARGET` は `<owner>/<repo>/<package>` 形式で指定してください
- 削除APIは本番イメージを消すため、十分注意してご利用ください

## 動作仕様

1. レジストリにログイン（docker login）
2. GHCR APIでイメージバージョン一覧を取得
3. 作成日時でソートし、KEEP_COUNT分だけ最新を残して古いものを削除
