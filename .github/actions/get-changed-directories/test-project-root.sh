#!/bin/bash

# プロジェクトルート検出のユニットテスト
# 一時ディレクトリにプロジェクト構造を作成し、
# find_project_root の動作を検証する

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

PROJECT_MARKERS=(
  "package.json"
  "pyproject.toml"
  "Dockerfile"
  "go.mod"
  "Cargo.toml"
  "Makefile"
  "docker-compose.yaml"
  "docker-compose.yml"
)

find_project_root() {
  local file="$1"
  local dir
  dir="$(dirname "$file")"

  while [[ "$dir" != "." && "$dir" != "/" && "$dir" != "" ]]; do
    for marker in "${PROJECT_MARKERS[@]}"; do
      if [[ -f "$dir/$marker" ]]; then
        echo "$dir"
        return 0
      fi
    done
    dir="$(dirname "$dir")"
  done
}

assert() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Project Root Detection Tests ==="
echo ""

TEST_DIR=$(mktemp -d)

cleanup() {
  [[ $BASH_SUBSHELL -eq 0 ]] || return 0
  cd /
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

cd "$TEST_DIR"

# --------------------------------------------------
# Test 1: 直下プロジェクト (projects/<name>)
# --------------------------------------------------
echo "[Test 1] Direct project under projects/"
mkdir -p "projects/portfolio/src"
touch "projects/portfolio/package.json"
assert "projects/portfolio/src/main.ts -> projects/portfolio" \
  "projects/portfolio" \
  "$(find_project_root "projects/portfolio/src/main.ts")"

# --------------------------------------------------
# Test 2: サブ階層プロジェクト (projects/labs/<name>)
# --------------------------------------------------
echo "[Test 2] Nested project under projects/labs/"
mkdir -p "projects/labs/tanstack-start-example/src"
mkdir -p "projects/labs/tanstack-start-example/public"
touch "projects/labs/tanstack-start-example/package.json"
assert "projects/labs/tanstack-start-example/src/a.ts -> projects/labs/tanstack-start-example" \
  "projects/labs/tanstack-start-example" \
  "$(find_project_root "projects/labs/tanstack-start-example/src/a.ts")"

# --------------------------------------------------
# Test 3: サブ階層プロジェクト (projects/samples/<name>)
# --------------------------------------------------
echo "[Test 3] Nested project under projects/samples/"
mkdir -p "projects/samples/cicd-ci-sample"
touch "projects/samples/cicd-ci-sample/Dockerfile"
assert "projects/samples/cicd-ci-sample/Dockerfile -> projects/samples/cicd-ci-sample" \
  "projects/samples/cicd-ci-sample" \
  "$(find_project_root "projects/samples/cicd-ci-sample/Dockerfile")"

# --------------------------------------------------
# Test 4: PoC プロジェクト (projects/poc/<name>)
# --------------------------------------------------
echo "[Test 4] Poc project under projects/poc/"
mkdir -p "projects/poc/backend-sse-chat-poc"
touch "projects/poc/backend-sse-chat-poc/pyproject.toml"
assert "projects/poc/backend-sse-chat-poc/Dockerfile -> projects/poc/backend-sse-chat-poc" \
  "projects/poc/backend-sse-chat-poc" \
  "$(find_project_root "projects/poc/backend-sse-chat-poc/Dockerfile")"

# --------------------------------------------------
# Test 5: 深いネストからの検出
# --------------------------------------------------
echo "[Test 5] Deep nesting"
mkdir -p "projects/labs/deep-project/src/components/ui/button"
touch "projects/labs/deep-project/pyproject.toml"
assert "projects/labs/deep-project/src/components/ui/button/index.tsx -> projects/labs/deep-project" \
  "projects/labs/deep-project" \
  "$(find_project_root "projects/labs/deep-project/src/components/ui/button/index.tsx")"

# --------------------------------------------------
# Test 6: マーカーファイルがない場合は出力なし
# --------------------------------------------------
echo "[Test 6] No marker file (no output expected)"
mkdir -p "projects/empty-project/src"
RESULT="$(find_project_root "projects/empty-project/src/main.ts" || true)"
assert "projects/empty-project/src/main.ts -> (empty)" \
  "" \
  "$RESULT"

# --------------------------------------------------
# Test 7: Python プロジェクト (pyproject.toml)
# --------------------------------------------------
echo "[Test 7] Python project (pyproject.toml)"
mkdir -p "projects/samples/python-sample"
touch "projects/samples/python-sample/pyproject.toml"
assert "projects/samples/python-sample/src/app.py -> projects/samples/python-sample" \
  "projects/samples/python-sample" \
  "$(find_project_root "projects/samples/python-sample/src/app.py")"

# --------------------------------------------------
# Test 8: Docker Compose プロジェクト
# --------------------------------------------------
echo "[Test 8] Docker Compose project"
mkdir -p "projects/samples/compose-sample/config"
touch "projects/samples/compose-sample/docker-compose.yaml"
assert "projects/samples/compose-sample/config/litellm.yml -> projects/samples/compose-sample" \
  "projects/samples/compose-sample" \
  "$(find_project_root "projects/samples/compose-sample/config/litellm.yml")"

# --------------------------------------------------
# Test 9: マーカーファイルが親にある場合
# --------------------------------------------------
echo "[Test 9] Marker at parent directory (Dockerfile in project root)"
mkdir -p "projects/container-app/src"
touch "projects/container-app/Dockerfile"
assert "projects/container-app/src/index.ts -> projects/container-app" \
  "projects/container-app" \
  "$(find_project_root "projects/container-app/src/index.ts")"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
