#!/bin/bash

# Docker イメージをビルドするスクリプト
# GitHub Actionとローカルテストの両方で使用

set -e

STAGE="$1"

# ステージパラメータのチェック
if [[ -z "$STAGE" ]]; then
  echo "Error: Stage parameter is required."
  exit 1
fi

echo "> Building Docker images for stage: $STAGE"

# build_projects.txt ファイルが存在するかチェック
if [[ ! -f "build_projects.txt" ]]; then
  echo "Error: build_projects.txt not found. Please run get-changed-projects first."
  exit 1
fi

# ファイルが空でないかチェック
if [[ ! -s "build_projects.txt" ]]; then
  echo "No projects to build."
  exit 0
fi

# 現在のコミットハッシュを取得
COMMIT_HASH=$(git rev-parse --short HEAD)
echo "Commit hash: $COMMIT_HASH"

# build_projects.txt からプロジェクトを読み取り
BUILD_PROJECTS=$(cat build_projects.txt)
echo "Projects to build: $BUILD_PROJECTS"

# カンマ区切りの場合とファイルの各行の場合の両方に対応
if [[ "$BUILD_PROJECTS" == *","* ]]; then
  # カンマ区切りの場合
  IFS=',' read -ra PROJECT_ARRAY <<< "$BUILD_PROJECTS"
else
  # 改行区切りの場合
  mapfile -t PROJECT_ARRAY < build_projects.txt
fi

echo "Build project count: ${#PROJECT_ARRAY[@]}"

for project in "${PROJECT_ARRAY[@]}"; do
  # 空行をスキップ
  [[ -z "$project" ]] && continue

  # プロジェクト名を取得（パスの最後の部分）
  project_name=$(basename "$project")

  GHCR_URI="ghcr.io/$GITHUB_REPOSITORY/$project_name:latest"
  DOCKER_FILE="$project/Dockerfile"
  SEARCH_KEYWORD="AS $STAGE"
  PREBUILD_SCRIPT_NAME="pre-docker-build.sh"

  echo ""
  echo "=== Building project: $project ==="
  echo "GHCR_URI: $GHCR_URI"
  echo "PROJECT_DIR: $project"
  echo "DOCKER_FILE: $DOCKER_FILE"
  echo "SEARCH_KEYWORD: $SEARCH_KEYWORD"

  # Dockerfileの存在チェック
  if [[ ! -f "$DOCKER_FILE" ]]; then
    echo "Error: Dockerfile not found at $DOCKER_FILE"
    continue
  fi

  # プレビルドスクリプトがプロジェクト配下に存在する場合は実行
  if [[ -f "$project/$PREBUILD_SCRIPT_NAME" ]]; then
    echo "Running pre-build script: $PREBUILD_SCRIPT_NAME"
    cd "$project"
    chmod +x "$PREBUILD_SCRIPT_NAME" && "./$PREBUILD_SCRIPT_NAME"
    cd - > /dev/null
  fi

  # Dockerfile内に指定したステージが存在するかチェック
  if grep -q "$SEARCH_KEYWORD" "$DOCKER_FILE" 2>/dev/null; then
    echo "Found stage: $STAGE"
    echo "Building with target: $STAGE"
    docker build --build-arg COMMIT_HASH="$COMMIT_HASH" -t "$GHCR_URI" --target="$STAGE" "$project"
  else
    echo "Stage '$STAGE' not found in Dockerfile"
    echo "Building without target"
    docker build --build-arg COMMIT_HASH="$COMMIT_HASH" -t "$GHCR_URI" "$project"
  fi

  echo "Successfully built: $GHCR_URI"
done

echo ""
echo "Docker image build completed."
