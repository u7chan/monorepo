#!/bin/bash

# build-docker-images アクションのローカルテスト用スクリプト

set -e

echo "=== Testing build-docker-images action locally ==="

# テスト用の build_projects.txt ファイルを作成
echo "Creating test build_projects.txt..."
cat > build_projects.txt << EOF
packages/chatbot-ui
EOF

echo "Contents of build_projects.txt:"
cat build_projects.txt

echo ""
echo "=== Running build-docker-images.sh ==="

# GitHub環境変数をモック
export GITHUB_REPOSITORY="test-user/test-repo"

# スクリプトを実行
./build-docker-images.sh "production"

echo ""
echo "=== Test completed ==="
