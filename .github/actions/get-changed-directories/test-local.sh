#!/bin/bash

# ローカルテスト用スクリプト
# GitHub Actionの get-changed-directories をローカルで実行するためのスクリプト

set -e

echo "=== Get Changed Directories (Local Test) ==="
echo ""

# 共通スクリプトを実行
"$(dirname "$0")/get-changed-dirs.sh"

echo "=== Test completed ==="
echo "Changed directories are saved in: changed_dirs.txt"
