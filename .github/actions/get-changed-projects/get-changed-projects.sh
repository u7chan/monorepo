#!/bin/bash

# 変更されたプロジェクトでDockerfileを持つものを取得するスクリプト
# GitHub Actionとローカルテストの両方で使用

set -e

# パラメータから必須ステージを取得
REQUIRED_STAGE="${1:-}"

# 変更されたディレクトリファイルが存在するかチェック
if [[ ! -f "changed_dirs.txt" ]]; then
  echo "Error: changed_dirs.txt not found. Please run get-changed-directories first."
  exit 1
fi

echo "> checking projects with Dockerfile"
if [[ -n "$REQUIRED_STAGE" ]]; then
  echo "> required stage: $REQUIRED_STAGE"
fi

# 変更されたプロジェクトを確認し、Dockerfile が存在するかチェック
BUILD_PROJECT=""
while read -r target; do
  # 空行をスキップ
  [[ -z "$target" ]] && continue

  if [[ -f "$target/Dockerfile" ]]; then
    echo "Dockerfile found: $target"

    # 必須ステージが指定されている場合はチェック
    if [[ -n "$REQUIRED_STAGE" ]]; then
      if grep -qE "AS\s+$REQUIRED_STAGE" "$target/Dockerfile"; then
        echo "  ✓ Stage '$REQUIRED_STAGE' found"
      else
        echo "  ✗ Stage '$REQUIRED_STAGE' not found, skipping"
        continue
      fi
    fi

    if [ -z "$BUILD_PROJECT" ]; then
      BUILD_PROJECT="$target"
    else
      BUILD_PROJECT="$BUILD_PROJECT,$target"
    fi
  else
    echo "No Dockerfile: $target/Dockerfile"
  fi
done < changed_dirs.txt

echo ""
echo "BUILD_PROJECT: $BUILD_PROJECT"

# GitHub Actions環境の場合は環境変数に設定
if [[ -n "$GITHUB_ENV" ]]; then
  echo "BUILD_PROJECT=$BUILD_PROJECT" >> "$GITHUB_ENV"
fi

# ローカルテスト用にファイルにも出力
echo "$BUILD_PROJECT" > build_projects.txt
echo "Build projects saved to: build_projects.txt"
