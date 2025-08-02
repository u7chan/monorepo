# Remove Old Docker Images Action

このアクションは、古いDockerイメージを削除し、プロジェクトごとに最新のN個のイメージのみを保持します。

## 概要

- `build_projects.txt` ファイルから対象プロジェクトを読み取り
- 各プロジェクトのGHCR上の古いイメージを削除
- 指定した数だけ最新のイメージを保持（デフォルト: 3個）
- GitHub Container Registry (GHCR) のイメージ削除に対応（`gh` CLIと`GITHUB_TOKEN`が必要）

## 入力パラメータ

| パラメータ | 説明 | 必須 | デフォルト値 |
|-----------|------|------|-------------|
| `keep_count` | プロジェクトごとに保持する最新イメージ数（コマンドライン引数1番目） | No | `3` |
| `GHCR_OWNER` | GHCRのOrganizationまたはユーザー名（コマンドライン引数2番目または環境変数） | No | `YOUR_ORG_OR_USER` |

## 使用例

### コマンドラインでの使用例

```bash
# デフォルト（3個残す）
./remove-old-docker-images.sh

# 5個残す
./remove-old-docker-images.sh 5

# オーナー指定
./remove-old-docker-images.sh 3 your-org-or-user
```

## 前提条件

- カレントディレクトリに `build_projects.txt` ファイルが存在すること
- `gh` CLI, `jq` コマンド, `GITHUB_TOKEN` 環境変数, `GHCR_OWNER`（Organizationまたはユーザー名）が必要
- GHCRの削除には `gh` CLI, `jq` コマンド, `GITHUB_TOKEN` 環境変数、`GHCR_OWNER`（Organizationまたはユーザー名）が必要

## 動作仕様

1. `build_projects.txt` からプロジェクト名を読み込み
2. 各プロジェクトについて、GHCR（GitHub Container Registry）のイメージバージョンを作成日時でソートし、`keep_count`を超える古いものを削除

## （補足）

このスクリプトはGHCR（GitHub Container Registry）上のイメージ削除専用です。ローカルのDockerイメージ削除やモックモード、test-local用スクリプトは不要になりました。
