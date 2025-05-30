#!/bin/bash

# Docker イメージをプッシュするスクリプト
# GitHub Actionとローカルテストの両方で使用
#
# 使用方法:
#   通常モード: ./push-docker-images.sh <registry> <username> <password>
#   モックモード: MOCK_DOCKER_COMMANDS=true ./push-docker-images.sh <registry> <username> <password>
#
# モックモード:
#   - 実際のDockerコマンドを実行せずに、すべてモックで動作
#   - test-local.shから呼び出される際に自動的に有効化
#   - ローカルテストでDockerが不要な場合に使用

set -e
# set -x  # デバッグ出力（必要に応じてコメントアウト）

# モックモードの環境変数をチェック
# MOCK_DOCKER_COMMANDS=true の場合、実際のDockerコマンドを実行せずにモックで動作
MOCK_MODE=${MOCK_DOCKER_COMMANDS:-false}

if [[ "$MOCK_MODE" == "true" ]]; then
  echo "[INFO] Mock mode enabled - Docker commands will be simulated"
fi

# Dockerコマンドを実行する関数（モック対応）
execute_docker_login() {
  local registry="$1"
  local username="$2"
  local password="$3"

  if [[ "$MOCK_MODE" == "true" ]]; then
    echo "[MOCK] docker login $registry -u $username --password-stdin"
    echo "[MOCK] Login successful"
    return 0
  else
    echo "$password" | docker login "$registry" -u "$username" --password-stdin
  fi
}

execute_docker_image_inspect() {
  local image_uri="$1"

  if [[ "$MOCK_MODE" == "true" ]]; then
    echo "[MOCK] docker image inspect $image_uri"
    echo "[MOCK] Image exists"
    return 0
  else
    docker image inspect "$image_uri" >/dev/null 2>&1
  fi
}

execute_docker_push() {
  local image_uri="$1"

  if [[ "$MOCK_MODE" == "true" ]]; then
    echo "[MOCK] docker push $image_uri"
    echo "[MOCK] Push successful"
    return 0
  else
    docker push "$image_uri"
  fi
}

## スクリプトの引数を取得
# 引数: レジストリ、ユーザー名、パスワード
REGISTRY="$1"
USERNAME="$2"
PASSWORD="$3"

# 引数のチェック
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

echo "> Pushing Docker images to registry: $REGISTRY"

# build_projects.txt ファイルが存在するかチェック
if [[ ! -f "build_projects.txt" ]]; then
  echo "Error: build_projects.txt not found. Please run get-changed-projects first."
  exit 1
fi

# ファイルが空でないかチェック
if [[ ! -s "build_projects.txt" ]]; then
  echo "No projects to push."
  exit 0
fi

# build_projects.txt からプロジェクトを読み取り
BUILD_PROJECTS=$(cat build_projects.txt)
echo "BUILD_PROJECTS: >>$BUILD_PROJECTS<<"


# レジストリにログイン
echo "Logging in to $REGISTRY..."
if execute_docker_login "$REGISTRY" "$USERNAME" "$PASSWORD"; then
  echo "Successfully logged in to $REGISTRY"
else
  echo "Warning: Failed to login to $REGISTRY (exit code: $?)"
  echo "This might be expected for local testing without a running registry"
  # ローカルテストの場合は続行、本番では失敗させる
  if [[ "$REGISTRY" == "localhost:"* ]] || [[ "$MOCK_MODE" == "true" ]]; then
    echo "Continuing with local test (registry login skipped)..."
  else
    echo "Registry login failed in production environment"
    exit 1
  fi
fi

# カンマ区切りの場合とファイルの各行の場合の両方に対応
if [[ "$BUILD_PROJECTS" == *","* ]]; then
  # カンマ区切りの場合
  IFS=',' read -ra PROJECT_ARRAY <<< "$BUILD_PROJECTS"
else
  # 改行区切りの場合（macOS互換）
  PROJECT_ARRAY=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && PROJECT_ARRAY+=("$line")
  done < build_projects.txt
fi

echo "Push project count: ${#PROJECT_ARRAY[@]}"

for project in "${PROJECT_ARRAY[@]}"; do
  # 空行をスキップ
  [[ -z "$project" ]] && continue

  # プロジェクト名を取得（パスの最後の部分）
  project_name=$(basename "$project")

  # GitHub Container Registry URI を構築
  if [[ -n "$GITHUB_REPOSITORY" ]]; then
    GHCR_URI="$REGISTRY/$GITHUB_REPOSITORY/$project_name:latest"
  else
    # ローカルテスト用のフォールバック
    GHCR_URI="$REGISTRY/test/$project_name:latest"
  fi

  echo ""
  echo "=== Pushing project: $project ==="
  echo "GHCR_URI: $GHCR_URI"

  # イメージが存在するかチェック
  if execute_docker_image_inspect "$GHCR_URI"; then
    echo "Pushing $GHCR_URI..."
    if [[ "$REGISTRY" == "localhost:"* ]] && [[ "$MOCK_MODE" != "true" ]]; then
      echo "Local test mode: Simulating push for $GHCR_URI"
      echo "(Actual push skipped - no local registry running)"
    else
      if execute_docker_push "$GHCR_URI"; then
        echo "Successfully pushed: $GHCR_URI"
      else
        echo "Error: Failed to push $GHCR_URI"
        exit 1
      fi
    fi
  else
    echo "Warning: Image $GHCR_URI not found locally. Skipping push."
  fi
done

echo ""
echo "Docker image push completed."
