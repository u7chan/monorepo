#!/bin/bash

# Dockerイメージのクリーンアップをトリガーするスクリプト
# GitHub Actionsとローカルテストの両方で使用

set -e

# 引数を取得
TOKEN="$1"
REPO_NAME="$2"
PROJECT_NAMES_CSV="$3"
KEEP_COUNT="${4:-3}"

# 引数のチェック
if [[ -z "$TOKEN" ]]; then
  echo "Error: GitHub token is required."
  exit 1
fi

if [[ -z "$REPO_NAME" ]]; then
  echo "Error: Repository name is required."
  exit 1
fi

if [[ -z "$PROJECT_NAMES_CSV" ]]; then
  echo "Warning: No projects specified for cleanup. Skipping."
  exit 0
fi

echo "Triggering cleanup for projects: $PROJECT_NAMES_CSV"
echo "Keeping $KEEP_COUNT most recent images"

# リポジトリディスパッチイベントを発行
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/u7chan/$REPO_NAME/dispatches" \
  -d '{
    "event_type": "deploy_trigger",
    "client_payload": {
      "target": "'"$PROJECT_NAMES_CSV"'",
      "keep_count": "'"$KEEP_COUNT"'"
    }
  }'

echo ""
echo "Cleanup trigger sent successfully."
