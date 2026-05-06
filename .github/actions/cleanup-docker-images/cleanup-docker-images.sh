#!/bin/bash

# Dockerイメージのクリーンアップをトリガーするスクリプト
# GitHub Actionsとローカルテストの両方で使用

set -e

# 引数を取得
TOKEN="$1"
REPO_NAME="$2"
PROJECT_NAMES_CSV="$3"
KEEP_COUNT="${4:-3}"
CLEANUP_MODE="${5:-normal}"

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
echo "Cleanup mode: $CLEANUP_MODE"

IMAGE_PATHS_CSV=""
IFS=',' read -ra PROJECT_NAMES <<< "$PROJECT_NAMES_CSV"
for project_name in "${PROJECT_NAMES[@]}"; do
  [[ -z "$project_name" ]] && continue

  if [[ "$project_name" == monorepo/* ]]; then
    image_path="$project_name"
  else
    image_path="monorepo/$project_name"
  fi

  if [[ -z "$IMAGE_PATHS_CSV" ]]; then
    IMAGE_PATHS_CSV="$image_path"
  else
    IMAGE_PATHS_CSV+=",$image_path"
  fi
done

if [[ -z "$IMAGE_PATHS_CSV" ]]; then
  echo "Warning: No image paths resolved for cleanup. Skipping."
  exit 0
fi

echo "Cleanup image paths: $IMAGE_PATHS_CSV"

# リポジトリディスパッチイベントを発行
curl -fsS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/u7chan/$REPO_NAME/dispatches" \
  -d '{
    "event_type": "deploy_local_trigger",
    "client_payload": {
      "image_path": "'"$IMAGE_PATHS_CSV"'",
      "keep_count": "'"$KEEP_COUNT"'",
      "cleanup_mode": "'"$CLEANUP_MODE"'"
    }
  }'

echo ""
echo "Cleanup trigger sent successfully."
