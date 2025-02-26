#!/bin/sh

set -ea

git diff --name-only HEAD HEAD~1 | \
  # 変更されたファイルがどのプロジェクトに属するかを確認
  grep '^projects/' | \
  awk -F/ '{print $2}'

echo "a" | grep a | awk -F/ '{print $1}'
echo "-"
echo "a" | grep z | awk -F/ '{print $1}'
echo "--"