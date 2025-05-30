#!/bin/bash

# ローカルテスト用スクリプト
# GitHub Actionの get-changed-projects をローカルで実行するためのスクリプト

set -e

echo "=== Get Changed Projects (Local Test) ==="
echo ""

# まず変更されたディレクトリを取得
echo "Step 1: Getting changed directories..."
"$(dirname "$0")/../get-changed-directories/get-changed-dirs.sh"
echo ""

# 次に変更されたプロジェクトでDockerfileを持つものを取得
echo "Step 2: Getting projects with Dockerfile..."
"$(dirname "$0")/get-changed-projects.sh"

echo ""
echo "=== Test completed ==="
echo "Changed directories are saved in: changed_dirs.txt"
echo "Build projects are saved in: build_projects.txt"
