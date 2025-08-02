#!/bin/bash

# ローカルテスト用スクリプト
# remove-old-docker-images アクションをモックモードでテストする
# 実際のDockerコマンドは実行せず、すべてシミュレーションで動作

set -e

echo "=== Testing remove-old-docker-images action locally ==="

# テスト用の環境変数を設定
export GITHUB_REPOSITORY="test/monorepo"
# 環境変数が設定されていない場合のみモックモードを有効化
export MOCK_DOCKER_COMMANDS="${MOCK_DOCKER_COMMANDS:-true}"

# テスト用のbuild_projects.txtを作成
echo "Creating test build_projects.txt..."
cat > build_projects.txt << EOF
projects/portfolio
projects/hono-mcp-server
projects/chatbot-ui
EOF

echo "Contents of build_projects.txt:"
cat build_projects.txt

# テスト用のkeep count
TEST_KEEP_COUNT="3"

echo ""
if [[ "$MOCK_DOCKER_COMMANDS" == "true" ]]; then
  echo "Mock mode enabled - skipping actual Docker image removal"
  
  # モック用のDockerイメージリストを作成
  echo "Creating mock Docker images for testing..."
  echo "REPOSITORY:TAG	CREATED"
  echo "portfolio:v1.0.0	2024-01-01 10:00:00"
  echo "portfolio:v2.0.0	2024-01-02 10:00:00"
  echo "portfolio:v3.0.0	2024-01-03 10:00:00"
  echo "portfolio:v4.0.0	2024-01-04 10:00:00"
  echo "portfolio:latest	2024-01-05 10:00:00"
  echo "hono-mcp-server:v1.0.0	2024-01-01 11:00:00"
  echo "hono-mcp-server:latest	2024-01-02 11:00:00"
else
  echo "Real Docker mode enabled - will execute actual Docker commands"
fi
echo "MOCK_DOCKER_COMMANDS=$MOCK_DOCKER_COMMANDS"

echo ""
echo "=== Running remove-old-docker-images.sh ==="

# スクリプトを実行
echo "Executing: ./remove-old-docker-images.sh $TEST_KEEP_COUNT"
echo "Working directory: $(pwd)"
echo "Script exists: $(test -f ./remove-old-docker-images.sh && echo 'YES' || echo 'NO')"
echo "Script executable: $(test -x ./remove-old-docker-images.sh && echo 'YES' || echo 'NO')"
echo ""

./remove-old-docker-images.sh "$TEST_KEEP_COUNT"

echo ""
echo "=== Test completed ==="

# クリーンアップ
echo ""
echo "Cleaning up test files..."
rm -f build_projects.txt

echo "Local test completed."
