#!/bin/bash

# ローカルテスト用スクリプト
# push-docker-images アクションをモックモードでテストする
# 実際のDockerコマンドは実行せず、すべてシミュレーションで動作

set -e

echo "=== Testing push-docker-images action locally ==="

# テスト用の環境変数を設定
export GITHUB_REPOSITORY="test/monorepo"
export MOCK_DOCKER_COMMANDS="true"  # モックモードを有効化

# テスト用のbuild_projects.txtを作成
echo "Creating test build_projects.txt..."
cat > build_projects.txt << EOF
projects/portfolio
projects/hono-mcp-server
EOF

echo "Contents of build_projects.txt:"
cat build_projects.txt

# テスト用のレジストリ情報
TEST_REGISTRY="localhost:5000"
TEST_USERNAME="testuser"
TEST_PASSWORD="testpass"

echo ""
echo "Mock mode enabled - skipping actual Docker image creation"
echo "MOCK_DOCKER_COMMANDS=$MOCK_DOCKER_COMMANDS"

echo ""
echo "=== Running push-docker-images.sh ==="

# スクリプトを実行（ドライラン的に）
# 実際のレジストリにプッシュしないよう、テスト用レジストリを使用
echo "Executing: ./push-docker-images.sh $TEST_REGISTRY $TEST_USERNAME [PASSWORD_HIDDEN]"
echo "Working directory: $(pwd)"
echo "Script exists: $(test -f ./push-docker-images.sh && echo 'YES' || echo 'NO')"
echo "Script executable: $(test -x ./push-docker-images.sh && echo 'YES' || echo 'NO')"
echo ""

./push-docker-images.sh "$TEST_REGISTRY" "$TEST_USERNAME" "$TEST_PASSWORD"

echo ""
echo "=== Mock test completed successfully ==="
echo "All Docker commands were simulated in mock mode."
echo ""
echo "To test with actual Docker commands:"
echo "1. Set MOCK_DOCKER_COMMANDS=false"
echo "2. Ensure Docker images exist locally"
echo "3. Optionally start a local registry: docker run -d -p 5000:5000 --name registry registry:2"

# クリーンアップ
echo ""
echo "Cleaning up test files..."
rm -f build_projects.txt
if [[ "$MOCK_DOCKER_COMMANDS" != "true" ]]; then
  docker rmi "$TEST_REGISTRY/$GITHUB_REPOSITORY/portfolio:latest" 2>/dev/null || true
  docker rmi "$TEST_REGISTRY/$GITHUB_REPOSITORY/hono-mcp-server:latest" 2>/dev/null || true
else
  echo "Mock mode - skipping Docker image cleanup"
fi

echo "Local test completed."
