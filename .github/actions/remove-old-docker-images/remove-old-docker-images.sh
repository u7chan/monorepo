#!/bin/bash

# Docker イメージの古いバージョンを削除する
# 最新 N 個のタグ付きイメージを残し、それ以外を削除する

set -e

## スクリプトの引数を取得
# 引数: 保持するイメージ数, ターゲット, レジストリ、ユーザー名、パスワード
KEEP_COUNT=${1:-3}
TARGET="$2"
REGISTRY="$3"
USERNAME="$4"
PASSWORD="$5"

# 引数のチェック

if [[ -z "$TARGET" ]]; then
  echo "Error: Target parameter is required."
  exit 1
fi

if [[ -z "$REGISTRY" ]]; then
  echo "Error: Registry parameter is required."
  exit 1
fi

if [[ -z "$USERNAME" ]]; then
  echo "Error: Username parameter is required."
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  echo "Error: Password parameter is required."
  exit 1
fi

# Dockerレジストリにログインする関数
execute_docker_login() {
  local registry="$1"
  local username="$2"
  local password="$3"
  echo "$password" | docker login "$registry" -u "$username" --password-stdin
}
# レジストリにログイン
echo "Logging in to $REGISTRY..."
if execute_docker_login "$REGISTRY" "$USERNAME" "$PASSWORD"; then
  echo "Successfully logged in to $REGISTRY"
else
  echo "Failed to login to $REGISTRY (exit code: $?)"
  exit 1
fi

echo "=== Removing old GHCR images (keeping latest $KEEP_COUNT) ==="

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Please install: https://stedolan.github.io/jq/"
  exit 1
fi

# ここからシンプルなAPIベースの削除処理
# 例: GHCR (ghcr.io) の場合
if [[ "$REGISTRY" == "ghcr.io" ]]; then
  if [[ -z "$GITHUB_TOKEN" ]]; then
    echo "GITHUB_TOKEN is not set. Please set it for authentication."
    exit 1
  fi
  OWNER=$(echo "$TARGET" | cut -d'/' -f1)
  REPO=$(echo "$TARGET" | cut -d'/' -f2)
  PACKAGE_NAME=$(echo "$TARGET" | cut -d'/' -f3)
  if [[ -z "$OWNER" || -z "$PACKAGE_NAME" ]]; then
    echo "TARGET must be in the form <owner>/<repo>/<package> for GHCR."
    exit 1
  fi
  echo "Querying GHCR API for $OWNER/$PACKAGE_NAME..."
  versions_json=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/orgs/$OWNER/packages/container/$PACKAGE_NAME/versions?per_page=100")
  version_count=$(echo "$versions_json" | jq 'length')
  if [[ -z "$versions_json" || "$version_count" -le "$KEEP_COUNT" ]]; then
    echo "No old images to remove for $TARGET"
  else
    delete_versions=$(echo "$versions_json" | jq -r '.[] | "\(.created_at)\t\(.id)\t\(.metadata.container.tags[0])"' | sort | head -n -"$KEEP_COUNT" | awk -F'\t' '{print $2}')
    if [[ -z "$delete_versions" ]]; then
      echo "No old images to remove for $TARGET"
    else
      echo "Removing old versions for $TARGET:"
      for vid in $delete_versions; do
        # シーケンステストが完了するまでコメントアウト
        # curl -s -X DELETE -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
        #  "https://api.github.com/orgs/$OWNER/packages/container/$PACKAGE_NAME/versions/$vid"
        echo "Deleted version $vid"
      done
    fi
  fi
  echo "Docker image cleanup completed."
  exit 0
fi

echo "Registry $REGISTRY is not supported by this script yet."
exit 1
