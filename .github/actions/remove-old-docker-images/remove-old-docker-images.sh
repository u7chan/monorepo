#!/bin/bash

# Docker イメージの古いバージョンを削除する
# 最新 N 個のタグ付きイメージを残し、それ以外を削除する

set -e


# 保持するイメージ数
KEEP_COUNT=${1:-3}

# GHCR用設定
GHCR_OWNER=${GHCR_OWNER:-"YOUR_ORG_OR_USER"} # 必要に応じて環境変数で指定
GHCR_PACKAGE_TYPE="container"

# gh/jqコマンドの存在チェック
## スクリプトの引数を取得
# 引数: 保持数, GHCR_OWNER（省略可）
KEEP_COUNT="$1"
GHCR_OWNER_ARG="$2"

# デフォルト値
if [[ -z "$KEEP_COUNT" ]]; then
  KEEP_COUNT=3
fi
GHCR_OWNER=${GHCR_OWNER_ARG:-${GHCR_OWNER:-"YOUR_ORG_OR_USER"}}
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for GHCR cleanup. Please install: https://stedolan.github.io/jq/"
  exit 1
fi

if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "GITHUB_TOKEN is not set. Please set it for authentication."
  exit 1
fi

echo "=== Removing old GHCR images (keeping latest $KEEP_COUNT) ==="

# build_projects.txt が存在するかチェック
if [[ ! -f "build_projects.txt" ]]; then
# 各プロジェクトについてGHCRイメージのみ削除
while IFS= read -r project || [[ -n "$project" ]]; do
        # パッケージバージョン一覧取得
        versions_json=$(gh api "/orgs/$GHCR_OWNER/packages/container/$project_name/versions?per_page=100" \
ghcr_authenticate() {
  if [[ -z "$GITHUB_TOKEN" ]]; then
    echo "Error: GITHUB_TOKEN is not set. Please set it for authentication."
    exit 1
  fi
  # gh CLIは自動的にGITHUB_TOKENを利用するが、明示的にログインしてもよい
  if gh auth status 2>&1 | grep -q 'Logged in to github.com'; then
    echo "Already authenticated with gh CLI."
    return 0
  fi
  echo "$GITHUB_TOKEN" | gh auth login --with-token || {
    echo "Error: Failed to authenticate gh CLI with GITHUB_TOKEN."; exit 1;
  }
}

ghcr_authenticate
            -H "Accept: application/vnd.github+json" 2>/dev/null || true)

        version_count=$(echo "$versions_json" | jq 'length')
        if [[ -z "$versions_json" || "$version_count" -le "$KEEP_COUNT" ]]; then
            echo "No old GHCR images to remove for $project_name"
        else
            # 作成日時でソートし、古いものを抽出
            delete_versions=$(echo "$versions_json" | \
                jq -r '.[] | "\(.created_at)\t\(.id)\t\(.metadata.container.tags[0])"' | \
                sort | \
                head -n -"$KEEP_COUNT" | \
                awk -F'\t' '{print $2}')

            if [[ -z "$delete_versions" ]]; then
                echo "No old GHCR images to remove for $project_name"
            else
                echo "Removing old GHCR versions for $project_name:"
                echo "$delete_versions"
                for vid in $delete_versions; do
                    gh api -X DELETE "/orgs/$GHCR_OWNER/packages/container/$project_name/versions/$vid"
                    echo "Deleted GHCR version $vid"
                done
            fi
        fi

        echo ""
    fi
done < build_projects.txt

echo "Docker image cleanup completed."
