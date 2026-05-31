#!/bin/bash

# get-changed-projects の PoC 除外ロジックのユニットテスト
# 一時ディレクトリにプロジェクト構造を作成し、
# Poc スキップロジックと requires-stage を検証する

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

assert() {
  local label="$1" expected="$2" actual="$3"
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

echo "=== get-changed-projects Tests ==="
echo ""

TEST_DIR=$(mktemp -d)

cleanup() {
  [[ $BASH_SUBSHELL -eq 0 ]] || return 0
  cd /
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

cd "$TEST_DIR"

# ヘルパー: get-changed-projects.sh のロジックを再現
run_logic() {
  local changed_dirs="$1"
  local required_stage="${2:-}"

  BUILD_PROJECT=""
  while read -r target; do
    [[ -z "$target" ]] && continue

    if [[ "$target" == projects/poc/* ]] || [[ "$target" == projects/poc ]]; then
      echo "Poc project (skip Docker auto build): $target" >&2
      continue
    fi

    if [[ -f "$target/Dockerfile" ]]; then
      if [[ -n "$required_stage" ]]; then
        if grep -qE "AS\s+$required_stage" "$target/Dockerfile"; then
          if [ -z "$BUILD_PROJECT" ]; then
            BUILD_PROJECT="$target"
          else
            BUILD_PROJECT="$BUILD_PROJECT,$target"
          fi
        fi
      else
        if [ -z "$BUILD_PROJECT" ]; then
          BUILD_PROJECT="$target"
        else
          BUILD_PROJECT="$BUILD_PROJECT,$target"
        fi
      fi
    fi
  done <<< "$changed_dirs"

  echo "$BUILD_PROJECT"
}

# --------------------------------------------------
# Test 1: 通常プロジェクト (Dockerfile あり)
# --------------------------------------------------
echo "[Test 1] Normal project with Dockerfile"
mkdir -p "projects/normal-app"
echo "FROM alpine" > "projects/normal-app/Dockerfile"
RESULT=$(run_logic "projects/normal-app")
assert "Normal Dockerfile project included" "projects/normal-app" "$RESULT"

# --------------------------------------------------
# Test 2: PoC プロジェクト (除外)
# --------------------------------------------------
echo "[Test 2] Poc project excluded from Docker build"
mkdir -p "projects/poc/test-poc"
echo "FROM alpine" > "projects/poc/test-poc/Dockerfile"
RESULT=$(run_logic "projects/poc/test-poc")
assert "Poc project excluded even with Dockerfile" "" "$RESULT"

# --------------------------------------------------
# Test 3: サブ階層 PoC (除外)
# --------------------------------------------------
echo "[Test 3] Nested poc project excluded"
mkdir -p "projects/poc/nested/sample"
echo "FROM alpine" > "projects/poc/nested/sample/Dockerfile"
RESULT=$(run_logic "projects/poc/nested/sample")
assert "Nested poc project excluded" "" "$RESULT"

# --------------------------------------------------
# Test 4: PoC 直下ディレクトリ (projects/poc)
# --------------------------------------------------
echo "[Test 4] Direct projects/poc entry excluded"
RESULT=$(run_logic "projects/poc")
assert "Direct projects/poc excluded" "" "$RESULT"

# --------------------------------------------------
# Test 5: 混合プロジェクト (PoC + 通常)
# --------------------------------------------------
echo "[Test 5] Mixed (PoC + normal)"
mkdir -p "projects/normal-app2"
echo "FROM node" > "projects/normal-app2/Dockerfile"
RESULT=$(run_logic $'projects/poc/test-poc\nprojects/normal-app2')
assert "Mixed: poc excluded, normal included" "projects/normal-app2" "$RESULT"

# --------------------------------------------------
# Test 6: Dockerfile がないプロジェクトは除外
# --------------------------------------------------
echo "[Test 6] Normal project without Dockerfile excluded"
mkdir -p "projects/no-docker-app"
RESULT=$(run_logic "projects/no-docker-app")
assert "No Dockerfile -> excluded" "" "$RESULT"

# --------------------------------------------------
# Test 7: サブ階層通常プロジェクト (Dockerfile あり)
# --------------------------------------------------
echo "[Test 7] Nested project with Dockerfile"
mkdir -p "projects/labs/docker-app"
echo "FROM ubuntu" > "projects/labs/docker-app/Dockerfile"
RESULT=$(run_logic "projects/labs/docker-app")
assert "Nested docker project included" "projects/labs/docker-app" "$RESULT"

# --------------------------------------------------
# Test 8: 複数プロジェクト (カンマ区切り)
# --------------------------------------------------
echo "[Test 8] Multiple projects comma-separated"
mkdir -p "projects/app-a"
mkdir -p "projects/app-b"
echo "FROM alpine" > "projects/app-a/Dockerfile"
echo "FROM alpine" > "projects/app-b/Dockerfile"
RESULT=$(run_logic $'projects/app-a\nprojects/app-b')
assert "Multiple projects in BUILD_PROJECT" "projects/app-a,projects/app-b" "$RESULT"

# --------------------------------------------------
# Test 9: required-stage あり（ステージあり Dockerfile）
# --------------------------------------------------
echo "[Test 9] Required stage filtering"
mkdir -p "projects/staged-app"
cat > "projects/staged-app/Dockerfile" << 'EOF'
FROM alpine AS build
RUN echo "build"
FROM alpine AS final
RUN echo "final"
EOF
RESULT=$(run_logic "projects/staged-app" "final")
assert "Staged app with matching stage" "projects/staged-app" "$RESULT"

# --------------------------------------------------
# Test 10: required-stage なし（ステージ不一致）
# --------------------------------------------------
echo "[Test 10] Required stage not matching"
mkdir -p "projects/test-only-app"
cat > "projects/test-only-app/Dockerfile" << 'EOF'
FROM alpine AS test
RUN echo "test"
EOF
RESULT=$(run_logic "projects/test-only-app" "final")
assert "No final stage -> excluded" "" "$RESULT"

# --------------------------------------------------
# Test 11: samples 階層の PoC ではないプロジェクトは含める
# --------------------------------------------------
echo "[Test 11] Samples project (not poc) included"
mkdir -p "projects/samples/cicd"
echo "FROM alpine" > "projects/samples/cicd/Dockerfile"
RESULT=$(run_logic "projects/samples/cicd")
assert "Samples project included" "projects/samples/cicd" "$RESULT"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
