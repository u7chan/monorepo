#!/bin/bash

# push-docker-images の複数タグテスト
# What: スペース区切りの複数タグをすべて push し、deploy handoff と
#       project_names_csv を出力することをモックモードで検証する

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/push-docker-images.sh"

PASS=0
FAIL=0

assert_eq() {
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

assert_contains() {
  local label="$1"
  local expected="$2"
  local file="$3"
  if grep -qF -- "$expected" "$file"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (not found: $expected)"
    echo "    log: $(cat "$file")"
    FAIL=$((FAIL + 1))
  fi
}

WORK_DIR="$(mktemp -d)"
cleanup() {
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$WORK_DIR"
echo "projects/example" > build_projects.txt

export GITHUB_REPOSITORY="owner/repo"
export GITHUB_OUTPUT="$WORK_DIR/github_output"
export MOCK_DOCKER_COMMANDS="true"

echo "=== 複数タグの push テスト ==="

bash "$SCRIPT" "localhost:5000" "user" "pass" "latest sha-abc1234" > "$WORK_DIR/script.log" 2>&1

assert_eq "docker push の呼び出し回数" "2" "$(grep -c '\[MOCK\] docker push' "$WORK_DIR/script.log")"
assert_contains "latest タグを push する" "localhost:5000/owner/repo/example:latest" "$WORK_DIR/script.log"
assert_contains "SHA タグを push する" "localhost:5000/owner/repo/example:sha-abc1234" "$WORK_DIR/script.log"
assert_eq "deploy handoff の件数" "2" "$(grep -c 'Deploy handoff' "$WORK_DIR/script.log")"
assert_contains "latest の handoff を出す" "image_tag=latest" "$WORK_DIR/script.log"
assert_contains "SHA タグの handoff を出す" "image_tag=sha-abc1234" "$WORK_DIR/script.log"
assert_eq "project_names_csv を出力する" "example" "$(sed -n 's/^project_names_csv=//p' "$WORK_DIR/github_output")"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
