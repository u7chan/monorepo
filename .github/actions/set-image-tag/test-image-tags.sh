#!/bin/bash

# イメージタグ生成のテスト
# What: 自動実行では latest と sha-<commit> を出力し、手動実行では manual タグだけを
#       出力する（latest を上書きしない）ことを検証する

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/set-image-tag.sh"

PASS=0
FAIL=0
last_rc=0

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

assert_failure() {
  local label="$1"
  if [[ "$last_rc" -ne 0 ]]; then
    echo "  PASS: $label (exit=$last_rc)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected non-zero exit, got 0)"
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
git init -q -b main .
git config user.email "test@example.com"
git config user.name "test"
mkdir -p projects/a
touch projects/a/package.json
git add -A
git commit -q -m base

FULL_SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"

output_value() {
  sed -n "s/^$1=//p" "$WORK_DIR/github_output"
}

run_tag() {
  last_rc=0
  : > "$WORK_DIR/github_output"
  GITHUB_OUTPUT="$WORK_DIR/github_output" bash "$SCRIPT" "$@" > "$WORK_DIR/script.log" 2>&1 || last_rc=$?
}

echo "=== イメージタグ生成テスト ==="

echo "[Test 1] 自動実行（push）"
run_tag "push" ""
assert_eq "image_tag は latest" "latest" "$(output_value image_tag)"
assert_eq "image_tags は latest と SHA タグ" "latest sha-${SHORT_SHA}" "$(output_value image_tags)"
assert_eq "commit_sha はビルド元の HEAD" "$FULL_SHA" "$(output_value commit_sha)"

echo "[Test 2] 手動実行（workflow_dispatch）"
run_tag "workflow_dispatch" "Feature/ABC_1"
assert_eq "image_tag は manual タグ" "manual-feature-abc_1-${SHORT_SHA}" "$(output_value image_tag)"
assert_eq "image_tags に latest を含めない" "manual-feature-abc_1-${SHORT_SHA}" "$(output_value image_tags)"
assert_eq "commit_sha はビルド元の HEAD" "$FULL_SHA" "$(output_value commit_sha)"

echo "[Test 3] 手動実行の ref が空"
run_tag "workflow_dispatch" ""
assert_failure "ref が空の場合は失敗する"

echo "[Test 4] 手動実行の ref がタグに使えない文字だけ"
run_tag "workflow_dispatch" "///"
assert_failure "サニタイズ後に空になる場合は失敗する"

echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
